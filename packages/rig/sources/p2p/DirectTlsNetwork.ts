import { isIP } from "node:net";
import type { Socket } from "node:net";
import { finished } from "node:stream/promises";
import {
    connect as connectTls,
    createServer as createTlsServer,
    type Server as TlsServer,
    type TLSSocket,
} from "node:tls";

import type { ConfigDirectTransport } from "../config/types.js";
import type { P2pPeerStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import {
    createDirectTlsCredentials,
    verifyDirectTlsCertificate,
    type DirectTlsCredentials,
} from "./DirectTlsCredentials.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import {
    readP2pHttpRequest,
    readP2pHttpResponse,
    writeP2pHttpFailure,
    writeP2pHttpRequest,
    writeP2pHttpResponse,
} from "./P2pFrameProtocol.js";
import { readBytes, writeBytes, type P2pFrameDuplex } from "./P2pFrameDuplex.js";
import { runP2pInitiatorHello, runP2pResponderHello } from "./P2pHelloProtocol.js";
import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "./P2pHttp.js";
import { encodeBase64Url, type P2pInstanceIdentity, type P2pPeerIdentity } from "./P2pIdentity.js";
import type { P2pTrustedPeer } from "./P2pPeer.js";
import type { P2pTransport } from "./P2pTransport.js";
import {
    createClosedP2pTunnelStream,
    type P2pTunnelConnection,
    type P2pTunnelRequestHead,
    type ServeP2pTunnel,
} from "./P2pTunnel.js";
import {
    readP2pTunnelRequest,
    readP2pTunnelResponse,
    writeP2pTunnelFailure,
    writeP2pTunnelRequest,
    writeP2pTunnelResponse,
} from "./P2pTunnelProtocol.js";
import { createP2pTunnelStream } from "./P2pTunnelStream.js";
import { formatDirectAddress, parseDirectAddress } from "./parseDirectAddress.js";

const DIRECT_ALPN = "rig-p2p-direct/2";
const DIRECT_EXPORTER_LABEL = "rig-p2p-direct-v1";
const OPERATION_HTTP = 2;
const OPERATION_PING = 1;
const OPERATION_TUNNEL = 3;
const MAXIMUM_CONNECTIONS = 32;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 5_000;
const INITIAL_RETRY_MS = 1_000;
const MAXIMUM_RETRY_MS = 30_000;

interface DirectPeer {
    address: string;
    instanceId: string;
    publicKey: string;
}

export interface CreateDirectTlsNetworkOptions {
    apiExposed?: boolean;
    closeTimeoutMs?: number;
    commitPeer?: (identity: P2pPeerIdentity, publicKey: string) => Promise<void>;
    config: ConfigDirectTransport;
    credentials?: DirectTlsCredentials;
    identity: P2pInstanceIdentity;
    maximumConnections?: number;
    onStatusChange?: (status: P2pTransportStatus) => void;
    peers: readonly P2pTrustedPeer[];
    serveRequest?: ServeP2pHttpRequest;
    serveTunnel?: ServeP2pTunnel;
    startPings?: boolean;
    validatePeer?: (identity: P2pPeerIdentity, publicKey: string) => Promise<void>;
}

export class DirectTlsNetwork implements P2pTransport {
    readonly kind = "direct" as const;
    readonly #apiExposed: boolean;
    readonly #abort = new AbortController();
    readonly #commitPeer: CreateDirectTlsNetworkOptions["commitPeer"];
    readonly #closeTimeoutMs: number;
    readonly #config: ConfigDirectTransport;
    readonly #credentials: DirectTlsCredentials;
    readonly #identity: P2pInstanceIdentity;
    readonly #maximumConnections: number;
    readonly #onStatusChange: CreateDirectTlsNetworkOptions["onStatusChange"];
    readonly #outboundSockets = new Set<TLSSocket>();
    readonly #peerById = new Map<string, DirectPeer>();
    readonly #peerByPublicKey = new Map<string, DirectPeer>();
    readonly #peerStatuses = new Map<string, P2pPeerStatus>();
    readonly #serveRequest: ServeP2pHttpRequest | undefined;
    readonly #serveTunnel: ServeP2pTunnel | undefined;
    readonly #startPings: boolean;
    readonly #sockets = new Set<TLSSocket>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #incomingSockets = new Set<Socket>();
    readonly #validatePeer: CreateDirectTlsNetworkOptions["validatePeer"];
    #localAddress: string | undefined;
    #server: TlsServer | undefined;

    private constructor(options: CreateDirectTlsNetworkOptions, credentials: DirectTlsCredentials) {
        this.#apiExposed =
            options.apiExposed ??
            (options.serveRequest !== undefined || options.serveTunnel !== undefined);
        this.#commitPeer = options.commitPeer;
        this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
        this.#config = options.config;
        this.#credentials = credentials;
        this.#identity = options.identity;
        this.#maximumConnections = options.maximumConnections ?? MAXIMUM_CONNECTIONS;
        this.#onStatusChange = options.onStatusChange;
        this.#serveRequest = options.serveRequest;
        this.#serveTunnel = options.serveTunnel;
        this.#startPings = options.startPings ?? true;
        this.#validatePeer = options.validatePeer;
        for (const configured of options.peers) {
            if (configured.connections.direct === undefined) continue;
            const peer: DirectPeer = {
                address: configured.connections.direct.address,
                instanceId: configured.instanceId,
                publicKey: configured.publicKey,
            };
            if (peer.instanceId === this.#identity.instanceId) {
                throw new Error("A direct P2P peer cannot use this Rig instance's own ID.");
            }
            this.#peerById.set(peer.instanceId, peer);
            this.#peerByPublicKey.set(peer.publicKey, peer);
            this.#peerStatuses.set(peer.instanceId, {
                address: peer.address,
                name: configured.name,
                peerId: peer.instanceId,
                publicKey: peer.publicKey,
                status: "connecting",
            });
        }
    }

    static async create(options: CreateDirectTlsNetworkOptions): Promise<DirectTlsNetwork> {
        const credentials =
            options.credentials ?? (await createDirectTlsCredentials(options.identity));
        const network = new DirectTlsNetwork(options, credentials);
        await network.#start();
        return network;
    }

    async close(): Promise<void> {
        this.#abort.abort();
        for (const socket of this.#sockets) socket.destroy();
        for (const socket of this.#incomingSockets) socket.destroy();
        await Promise.allSettled([
            withDeadline(
                closeServer(this.#server),
                this.#closeTimeoutMs,
                "The direct P2P listener did not close in time.",
            ),
            withDeadline(
                Promise.allSettled(this.#tasks),
                this.#closeTimeoutMs,
                "Direct P2P connection work did not stop in time.",
            ),
        ]);
    }

    async fetch(
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<P2pHttpResponse> {
        const peer = this.#peerById.get(peerId);
        if (peer === undefined) throw new Error("That peer has no configured direct address.");
        const socket = await this.#connectAndAuthenticate(peer, signal);
        const duplex = createNodeFrameDuplex(socket, socket);
        const aborted = () => socket.destroy();
        const close = () => {
            signal.removeEventListener("abort", aborted);
            socket.destroy();
        };
        if (signal.aborted) {
            close();
            throw new Error("The direct P2P request was cancelled.");
        }
        signal.addEventListener("abort", aborted, { once: true });
        try {
            await writeBytes(duplex.send, Uint8Array.of(OPERATION_HTTP));
            await writeP2pHttpRequest(duplex.send, request);
            return await withDeadline(
                readP2pHttpResponse(duplex.recv, close),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The direct P2P peer did not return response headers in time.",
            );
        } catch (error) {
            close();
            throw error;
        }
    }

    async openTunnel(
        peerId: string,
        request: P2pTunnelRequestHead,
        signal: AbortSignal,
    ): Promise<P2pTunnelConnection> {
        const peer = this.#peerById.get(peerId);
        if (peer === undefined) throw new Error("That peer has no configured direct address.");
        const socket = await this.#connectAndAuthenticate(peer, signal);
        const duplex = createNodeFrameDuplex(socket, socket);
        const close = () => socket.destroy();
        if (signal.aborted) {
            close();
            throw new Error("The direct P2P tunnel was cancelled.");
        }
        signal.addEventListener("abort", close, { once: true });
        try {
            await writeBytes(duplex.send, Uint8Array.of(OPERATION_TUNNEL));
            await withDeadline(
                writeP2pTunnelRequest(duplex.send, request),
                REQUEST_TIMEOUT_MS,
                "The direct P2P tunnel request took too long to send.",
            );
            const response = await withDeadline(
                readP2pTunnelResponse(duplex.recv),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The direct P2P peer did not return tunnel headers in time.",
            );
            if (response.status !== (request.method === "GET" ? 101 : 200)) {
                signal.removeEventListener("abort", close);
                close();
                return { response, stream: createClosedP2pTunnelStream() };
            }
            signal.removeEventListener("abort", close);
            return {
                response,
                stream: createP2pTunnelStream(duplex, { close, signal }),
            };
        } catch (error) {
            signal.removeEventListener("abort", close);
            close();
            throw error;
        }
    }

    status(): Extract<P2pTransportStatus, { state: "ready"; transport: "direct" }> {
        return {
            apiExposed: this.#apiExposed,
            ...(this.#localAddress === undefined ? {} : { localAddress: this.#localAddress }),
            peers: [...this.#peerById.keys()].map((peerId) => ({
                ...this.#peerStatuses.get(peerId)!,
            })),
            state: "ready",
            transport: "direct",
        };
    }

    async #start(): Promise<void> {
        if (this.#config.listen !== undefined) await this.#startServer(this.#config.listen);
        if (this.#startPings) {
            for (const peer of this.#peerById.values()) this.#track(this.#pingPeer(peer));
        }
        this.#publishStatus();
    }

    async #startServer(listenAddress: string): Promise<void> {
        const listen = parseDirectAddress(listenAddress);
        const server = createTlsServer({
            ALPNProtocols: [DIRECT_ALPN],
            cert: this.#credentials.certificate,
            key: this.#credentials.privateKey,
            minVersion: "TLSv1.3",
            rejectUnauthorized: false,
            requestCert: true,
        });
        this.#server = server;
        server.on("connection", (socket) => {
            if (this.#incomingSockets.size >= this.#maximumConnections) {
                socket.destroy();
                return;
            }
            // The slot remains reserved after TLS completes and until the
            // authenticated connection closes.
            this.#incomingSockets.add(socket);
            socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
            socket.once("close", () => this.#incomingSockets.delete(socket));
        });
        server.on("secureConnection", (socket) => {
            socket.setTimeout(0);
            this.#track(this.#serveIncoming(socket));
        });
        server.on("tlsClientError", () => undefined);
        await listenServer(server, listen.host, listen.port);
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("The direct P2P listener did not return a TCP address.");
        }
        this.#localAddress = formatDirectAddress({ host: address.address, port: address.port });
    }

    async #serveIncoming(socket: TLSSocket): Promise<void> {
        this.#sockets.add(socket);
        try {
            this.#assertAlpn(socket);
            const certificatePublicKey = this.#peerCertificatePublicKey(socket);
            const expected = this.#peerByPublicKey.get(certificatePublicKey);
            if (expected === undefined) {
                throw new Error("The direct P2P peer certificate is not on the allowlist.");
            }
            const channelBinding = this.#channelBinding(socket);
            const duplex = createNodeFrameDuplex(socket, socket);
            const identity = await withDeadline(
                runP2pResponderHello(duplex, {
                    commitPeer: (peerIdentity) =>
                        this.#commitAuthenticatedPeer(peerIdentity, certificatePublicKey),
                    identity: this.#identity,
                    localChannelBinding: channelBinding,
                    remoteChannelBinding: channelBinding,
                    transport: "direct",
                    validatePeer: (peerIdentity) =>
                        this.#validateAuthenticatedPeer(
                            peerIdentity,
                            certificatePublicKey,
                            expected,
                        ),
                }),
                HANDSHAKE_TIMEOUT_MS,
                "The direct P2P peer did not finish its signed hello in time.",
            );
            const operation = (
                await withDeadline(
                    readBytes(duplex.recv, 1),
                    HANDSHAKE_TIMEOUT_MS,
                    "The direct P2P peer did not choose an operation in time.",
                )
            )[0];
            if (operation === OPERATION_PING) {
                await writeBytes(duplex.send, Uint8Array.of(OPERATION_PING));
                socket.end();
                return;
            }
            if (operation === OPERATION_HTTP) {
                await this.#serveHttp(socket, duplex, identity.instanceId);
                return;
            }
            if (operation === OPERATION_TUNNEL) {
                await this.#serveTunnelConnection(socket, duplex, identity.instanceId);
                return;
            }
            throw new Error("Unknown direct P2P operation.");
        } catch {
            socket.destroy();
        } finally {
            this.#sockets.delete(socket);
        }
    }

    async #serveTunnelConnection(
        socket: TLSSocket,
        duplex: P2pFrameDuplex,
        peerId: string,
    ): Promise<void> {
        if (this.#serveTunnel === undefined) {
            await writeP2pTunnelFailure(
                duplex.send,
                new Error("P2P API sharing is disabled."),
            ).catch(() => undefined);
            socket.end();
            return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        socket.once("close", abort);
        let local: P2pTunnelConnection | undefined;
        let tunnel: ReturnType<typeof createP2pTunnelStream> | undefined;
        try {
            const request = await withDeadline(
                readP2pTunnelRequest(duplex.recv),
                REQUEST_TIMEOUT_MS,
                "The direct P2P peer did not finish its tunnel request in time.",
            );
            local = await withDeadline(
                this.#serveTunnel(peerId, request, controller.signal),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The local daemon did not open the tunnel in time.",
            );
            await writeP2pTunnelResponse(duplex.send, local.response);
            if (local.response.status !== (request.method === "GET" ? 101 : 200)) {
                local.stream.destroy();
                socket.end();
                return;
            }
            tunnel = createP2pTunnelStream(duplex, {
                close: () => socket.destroy(),
                signal: controller.signal,
            });
            local.stream.pipe(tunnel);
            tunnel.pipe(local.stream);
            await Promise.all([finished(local.stream), finished(tunnel)]);
        } catch (error) {
            if (local === undefined && !controller.signal.aborted) {
                await writeP2pTunnelFailure(duplex.send, error).catch(() => undefined);
            }
            local?.stream.destroy();
            tunnel?.destroy();
            socket.destroy();
        } finally {
            socket.off("close", abort);
            controller.abort();
        }
    }

    async #serveHttp(socket: TLSSocket, duplex: P2pFrameDuplex, peerId: string): Promise<void> {
        if (this.#serveRequest === undefined) {
            await writeP2pHttpFailure(duplex.send, new Error("P2P API sharing is disabled.")).catch(
                () => undefined,
            );
            socket.end();
            return;
        }
        const controller = new AbortController();
        socket.once("close", () => controller.abort());
        try {
            const request = await withDeadline(
                readP2pHttpRequest(duplex.recv),
                REQUEST_TIMEOUT_MS,
                "The direct P2P peer did not finish its request in time.",
            );
            const response = await withDeadline(
                this.#serveRequest(peerId, request, controller.signal),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The local daemon did not return response headers in time.",
            );
            await writeP2pHttpResponse(duplex.send, response);
            socket.end();
        } catch (error) {
            if (!controller.signal.aborted) {
                await writeP2pHttpFailure(duplex.send, error).catch(() => undefined);
            }
            socket.destroy();
        } finally {
            controller.abort();
        }
    }

    async #pingPeer(peer: DirectPeer): Promise<void> {
        let retryMs = INITIAL_RETRY_MS;
        while (!this.#abort.signal.aborted) {
            const startedAt = Date.now();
            try {
                this.#setPeerStatus(peer, "connecting");
                const socket = await this.#connectAndAuthenticate(peer, this.#abort.signal);
                const duplex = createNodeFrameDuplex(socket, socket);
                try {
                    await writeBytes(duplex.send, Uint8Array.of(OPERATION_PING));
                    const response = await withDeadline(
                        readBytes(duplex.recv, 1),
                        PING_TIMEOUT_MS,
                        "The direct P2P peer did not answer its ping in time.",
                    );
                    if (response[0] !== OPERATION_PING) {
                        throw new Error("The direct P2P peer returned an invalid ping.");
                    }
                } finally {
                    socket.destroy();
                }
                retryMs = INITIAL_RETRY_MS;
                this.#setPeerStatus(peer, "connected", {
                    lastSeenAt: Date.now(),
                    rttMs: Date.now() - startedAt,
                });
                await wait(PING_INTERVAL_MS, this.#abort.signal);
            } catch (error) {
                if (this.#abort.signal.aborted) return;
                this.#setPeerStatus(peer, "unreachable", { error: errorToMessage(error) });
                await wait(retryMs, this.#abort.signal);
                retryMs = Math.min(MAXIMUM_RETRY_MS, retryMs * 2);
            }
        }
    }

    async #connectAndAuthenticate(peer: DirectPeer, signal: AbortSignal): Promise<TLSSocket> {
        if (this.#outboundSockets.size >= this.#maximumConnections) {
            throw new Error("Too many outbound direct P2P connections are already open.");
        }
        const address = parseDirectAddress(peer.address);
        const socket = connectTls({
            ALPNProtocols: [DIRECT_ALPN],
            cert: this.#credentials.certificate,
            host: address.host,
            key: this.#credentials.privateKey,
            minVersion: "TLSv1.3",
            port: address.port,
            rejectUnauthorized: false,
            requestCert: true,
            ...(isIP(address.host) === 0 ? { servername: address.host } : {}),
        });
        this.#outboundSockets.add(socket);
        this.#sockets.add(socket);
        socket.once("close", () => {
            this.#outboundSockets.delete(socket);
            this.#sockets.delete(socket);
        });
        try {
            await waitForSecureConnect(socket, signal);
            this.#assertAlpn(socket);
            const certificatePublicKey = this.#peerCertificatePublicKey(socket);
            if (certificatePublicKey !== peer.publicKey) {
                throw new Error(
                    "The direct P2P peer certificate key does not match its allowlist.",
                );
            }
            const channelBinding = this.#channelBinding(socket);
            const identity = await withDeadline(
                runP2pInitiatorHello(createNodeFrameDuplex(socket, socket), {
                    commitPeer: (peerIdentity) =>
                        this.#commitAuthenticatedPeer(peerIdentity, certificatePublicKey),
                    identity: this.#identity,
                    localChannelBinding: channelBinding,
                    remoteChannelBinding: channelBinding,
                    transport: "direct",
                    validatePeer: (peerIdentity) =>
                        this.#validateAuthenticatedPeer(peerIdentity, certificatePublicKey, peer),
                }),
                HANDSHAKE_TIMEOUT_MS,
                "The direct P2P peer did not finish its signed hello in time.",
            );
            if (identity.instanceId !== peer.instanceId) {
                throw new Error("The direct address belongs to another Rig instance.");
            }
            return socket;
        } catch (error) {
            socket.destroy();
            throw error;
        }
    }

    #peerCertificatePublicKey(socket: TLSSocket): string {
        const certificate = socket.getPeerX509Certificate();
        if (certificate === undefined) {
            throw new Error("The direct P2P peer did not provide a TLS certificate.");
        }
        return verifyDirectTlsCertificate(certificate);
    }

    #channelBinding(socket: TLSSocket): string {
        return encodeBase64Url(
            socket.exportKeyingMaterial(32, DIRECT_EXPORTER_LABEL, Buffer.alloc(0)),
        );
    }

    #assertAlpn(socket: TLSSocket): void {
        if (socket.alpnProtocol !== DIRECT_ALPN) {
            throw new Error("The direct P2P peer did not negotiate the Rig protocol.");
        }
    }

    async #validateAuthenticatedPeer(
        identity: P2pPeerIdentity,
        certificatePublicKey: string,
        expected: DirectPeer,
    ): Promise<void> {
        if (
            identity.instanceId !== expected.instanceId ||
            identity.publicKey !== expected.publicKey ||
            identity.publicKey !== certificatePublicKey
        ) {
            throw new Error("The direct P2P peer identity does not match its allowlist.");
        }
        await this.#validatePeer?.(identity, certificatePublicKey);
    }

    async #commitAuthenticatedPeer(
        identity: P2pPeerIdentity,
        certificatePublicKey: string,
    ): Promise<void> {
        await this.#commitPeer?.(identity, certificatePublicKey);
    }

    #setPeerStatus(
        peer: DirectPeer,
        status: P2pPeerStatus["status"],
        details: Pick<P2pPeerStatus, "error" | "lastSeenAt" | "rttMs"> = {},
    ): void {
        const previous = this.#peerStatuses.get(peer.instanceId);
        const next: P2pPeerStatus = {
            address: peer.address,
            ...details,
            peerId: peer.instanceId,
            publicKey: peer.publicKey,
            status,
        };
        this.#peerStatuses.set(peer.instanceId, next);
        if (previous?.status !== next.status || previous.error !== next.error)
            this.#publishStatus();
    }

    #publishStatus(): void {
        try {
            this.#onStatusChange?.(this.status());
        } catch {
            // Optional status delivery must not break transport work.
        }
    }

    #track(task: Promise<void>): void {
        this.#tasks.add(task);
        void task.finally(() => this.#tasks.delete(task));
    }
}

function waitForSecureConnect(socket: TLSSocket, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => finish(new Error("The direct P2P TLS handshake timed out.")),
            HANDSHAKE_TIMEOUT_MS,
        );
        const connected = () => finish();
        const failed = (error: Error) => finish(error);
        const aborted = () => finish(new Error("The direct P2P connection was cancelled."));
        const finish = (error?: Error) => {
            clearTimeout(timer);
            socket.off("secureConnect", connected);
            socket.off("error", failed);
            signal.removeEventListener("abort", aborted);
            if (error === undefined) resolve();
            else reject(error);
        };
        if (signal.aborted) return aborted();
        socket.once("secureConnect", connected);
        socket.once("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
    });
}

function listenServer(server: TlsServer, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const failed = (error: Error) => {
            server.off("listening", listening);
            reject(error);
        };
        const listening = () => {
            server.off("error", failed);
            resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(port, host);
    });
}

function closeServer(server: TlsServer | undefined): Promise<void> {
    if (server === undefined || !server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        void operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        let timer: NodeJS.Timeout;
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        timer = setTimeout(finish, milliseconds);
        signal.addEventListener("abort", finish, { once: true });
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : "The direct P2P peer is unreachable.";
}
