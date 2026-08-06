import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { P2pPeerStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import {
    readBytes,
    writeBytes,
    type P2pFrameDuplex,
    type P2pFrameReader,
} from "./P2pFrameDuplex.js";
import { readP2pHttpResponse, writeP2pHttpRequest } from "./P2pFrameProtocol.js";
import { runP2pInitiatorHello } from "./P2pHelloProtocol.js";
import type { P2pHttpRequest, P2pHttpResponse } from "./P2pHttp.js";
import { encodeBase64Url, type P2pInstanceIdentity, type P2pPeerIdentity } from "./P2pIdentity.js";
import {
    createClosedP2pTunnelStream,
    type P2pTunnelConnection,
    type P2pTunnelRequestHead,
} from "./P2pTunnel.js";
import { readP2pTunnelResponse, writeP2pTunnelRequest } from "./P2pTunnelProtocol.js";
import { createP2pTunnelStream } from "./P2pTunnelStream.js";
import { loadSshClientConfig } from "./loadSshClientConfig.js";
import type { P2pSshPeer, P2pTrustedPeer } from "./P2pPeer.js";
import type { P2pTransport } from "./P2pTransport.js";

/**
 * The remote `rig p2p bridge --stdio` process speaks the shared framed protocol
 * over the SSH channel's stdin and stdout. Because SSH already authenticates the
 * host, the bridge cannot observe the transport keys the signed hello needs to
 * bind to. The initiator therefore opens with this preface, handing the remote
 * side the host-key hash it just verified so both ends derive the same channel
 * binding.
 */
export const SSH_BRIDGE_PREFACE_VERSION = 2;
export const SSH_HOST_KEY_HASH_BYTES = 32;
export const SSH_BRIDGE_PREFACE_BYTES = 1 + SSH_HOST_KEY_HASH_BYTES;
export const SSH_OPERATION_PING = 1;
export const SSH_OPERATION_HTTP = 2;
export const SSH_OPERATION_TUNNEL = 3;

const SSH_BRIDGE_ARGUMENTS = "p2p bridge --stdio";
const CONNECT_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const MAXIMUM_CHANNELS = 16;
const MAXIMUM_STDERR_BYTES = 8 * 1024;

/** One authenticated SSH exec of the remote bridge, seen as a byte stream. */
export interface SshBridgeChannel {
    readonly duplex: P2pFrameDuplex;
    /** The host-key hash this connection verified, which becomes the channel binding. */
    readonly hostKeyHash: Uint8Array;
    close(): void;
    /** Whatever the remote command printed on stderr, bounded and trimmed. */
    diagnostics(): string;
}

interface SshPeer {
    address: string;
    instanceId: string;
    publicKey: string;
    ssh: P2pSshPeer;
}

export interface CreateSshTransportOptions {
    commitPeer?: (identity: P2pPeerIdentity, channelBinding: string) => Promise<void>;
    connectTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    identity: P2pInstanceIdentity;
    onStatusChange?: (status: P2pTransportStatus) => void;
    /** Replaced in tests so the transport can run without a live SSH server. */
    openChannel?: (peer: P2pSshPeer, signal: AbortSignal) => Promise<SshBridgeChannel>;
    peers: readonly P2pTrustedPeer[];
    validatePeer?: (identity: P2pPeerIdentity, channelBinding: string) => Promise<void>;
}

/**
 * Reaches other Rig instances by running their bridge command over SSH.
 *
 * This transport only ever initiates: it has no listener, and it opens a fresh
 * SSH connection and exec for each operation. Every configured peer stays in the
 * reported status even while nothing is in flight, so a caller can still choose
 * SSH for a peer this Rig has not spoken to yet.
 */
export class SshTransport implements P2pTransport {
    readonly kind = "ssh" as const;
    readonly #abort = new AbortController();
    readonly #channels = new Set<SshBridgeChannel>();
    readonly #commitPeer: CreateSshTransportOptions["commitPeer"];
    readonly #connectTimeoutMs: number;
    readonly #environment: NodeJS.ProcessEnv | undefined;
    readonly #identity: P2pInstanceIdentity;
    readonly #onStatusChange: CreateSshTransportOptions["onStatusChange"];
    readonly #openChannel: NonNullable<CreateSshTransportOptions["openChannel"]>;
    readonly #peerById = new Map<string, SshPeer>();
    readonly #peerStatuses = new Map<string, P2pPeerStatus>();
    readonly #validatePeer: CreateSshTransportOptions["validatePeer"];
    #pendingChannels = 0;

    constructor(options: CreateSshTransportOptions) {
        this.#commitPeer = options.commitPeer;
        this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        this.#environment = options.environment;
        this.#identity = options.identity;
        this.#onStatusChange = options.onStatusChange;
        this.#validatePeer = options.validatePeer;
        this.#openChannel =
            options.openChannel ??
            ((peer, signal) =>
                openSshBridgeChannel(peer, signal, {
                    connectTimeoutMs: this.#connectTimeoutMs,
                    ...(this.#environment === undefined ? {} : { environment: this.#environment }),
                }));
        for (const configured of options.peers) {
            if (configured.connections.ssh === undefined) continue;
            if (configured.instanceId === this.#identity.instanceId) {
                throw new Error("An SSH P2P peer cannot use this Rig instance's own ID.");
            }
            const peer: SshPeer = {
                address: formatSshAddress(configured.connections.ssh),
                instanceId: configured.instanceId,
                publicKey: configured.publicKey,
                ssh: configured.connections.ssh,
            };
            this.#peerById.set(peer.instanceId, peer);
            this.#peerStatuses.set(peer.instanceId, {
                address: peer.address,
                name: configured.name,
                peerId: peer.instanceId,
                publicKey: peer.publicKey,
                status: "connecting",
            });
        }
    }

    static create(options: CreateSshTransportOptions): SshTransport {
        const transport = new SshTransport(options);
        transport.#publishStatus();
        return transport;
    }

    async close(): Promise<void> {
        this.#abort.abort();
        for (const channel of this.#channels) channel.close();
        this.#channels.clear();
        await Promise.resolve();
    }

    async fetch(
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<P2pHttpResponse> {
        const peer = this.#peerById.get(peerId);
        if (peer === undefined) throw new Error("That peer has no configured SSH bridge.");
        const startedAt = Date.now();
        const channel = await this.#openAuthenticatedChannel(peer, signal);
        const release = () => {
            signal.removeEventListener("abort", release);
            this.#releaseChannel(channel);
        };
        if (signal.aborted) {
            release();
            throw new Error("The SSH P2P request was cancelled.");
        }
        signal.addEventListener("abort", release, { once: true });
        try {
            await writeBytes(channel.duplex.send, Uint8Array.of(SSH_OPERATION_HTTP));
            await withDeadline(
                writeP2pHttpRequest(channel.duplex.send, request),
                REQUEST_TIMEOUT_MS,
                "The SSH P2P request took too long to send.",
                () => channel.close(),
            );
            const response = await withDeadline(
                readP2pHttpResponse(channel.duplex.recv, release),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The SSH P2P bridge did not return response headers in time.",
                () => channel.close(),
            );
            this.#setPeerStatus(peer, "connected", {
                lastSeenAt: Date.now(),
                rttMs: Date.now() - startedAt,
            });
            return response;
        } catch (error) {
            release();
            this.#setPeerStatus(peer, "unreachable", {
                error: describeFailure(error, channel),
            });
            throw error;
        }
    }

    async openTunnel(
        peerId: string,
        request: P2pTunnelRequestHead,
        signal: AbortSignal,
    ): Promise<P2pTunnelConnection> {
        const peer = this.#peerById.get(peerId);
        if (peer === undefined) throw new Error("That peer has no configured SSH bridge.");
        const startedAt = Date.now();
        const channel = await this.#openAuthenticatedChannel(peer, signal);
        const release = () => {
            signal.removeEventListener("abort", release);
            this.#releaseChannel(channel);
        };
        if (signal.aborted) {
            release();
            throw new Error("The SSH P2P tunnel was cancelled.");
        }
        signal.addEventListener("abort", release, { once: true });
        try {
            await writeBytes(channel.duplex.send, Uint8Array.of(SSH_OPERATION_TUNNEL));
            await withDeadline(
                writeP2pTunnelRequest(channel.duplex.send, request),
                REQUEST_TIMEOUT_MS,
                "The SSH P2P tunnel request took too long to send.",
                () => channel.close(),
            );
            const response = await withDeadline(
                readP2pTunnelResponse(channel.duplex.recv),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The SSH P2P bridge did not return tunnel response headers in time.",
                () => channel.close(),
            );
            if (response.status !== (request.method === "GET" ? 101 : 200)) {
                release();
                return { response, stream: createClosedP2pTunnelStream() };
            }
            this.#setPeerStatus(peer, "connected", {
                lastSeenAt: Date.now(),
                rttMs: Date.now() - startedAt,
            });
            return {
                response,
                stream: createP2pTunnelStream(channel.duplex, {
                    close: release,
                    signal,
                }),
            };
        } catch (error) {
            release();
            this.#setPeerStatus(peer, "unreachable", {
                error: describeFailure(error, channel),
            });
            throw error;
        }
    }

    /** Opens a bridge, runs the signed hello, and leaves the channel ready for an operation. */
    async ping(peerId: string, signal: AbortSignal): Promise<void> {
        const peer = this.#peerById.get(peerId);
        if (peer === undefined) throw new Error("That peer has no configured SSH bridge.");
        const startedAt = Date.now();
        const channel = await this.#openAuthenticatedChannel(peer, signal);
        try {
            await writeBytes(channel.duplex.send, Uint8Array.of(SSH_OPERATION_PING));
            const answer = await withDeadline(
                readBytes(channel.duplex.recv, 1),
                HANDSHAKE_TIMEOUT_MS,
                "The SSH P2P bridge did not answer its ping in time.",
                () => channel.close(),
            );
            if (answer[0] !== SSH_OPERATION_PING) {
                throw new Error("The SSH P2P bridge returned an invalid ping.");
            }
            this.#setPeerStatus(peer, "connected", {
                lastSeenAt: Date.now(),
                rttMs: Date.now() - startedAt,
            });
        } catch (error) {
            this.#setPeerStatus(peer, "unreachable", { error: describeFailure(error, channel) });
            throw error;
        } finally {
            this.#releaseChannel(channel);
        }
    }

    status(): Extract<P2pTransportStatus, { transport: "ssh" }> {
        return {
            direction: "outbound",
            peers: [...this.#peerById.keys()].map((peerId) => ({
                ...this.#peerStatuses.get(peerId)!,
            })),
            state: "ready",
            transport: "ssh",
        };
    }

    async #openAuthenticatedChannel(peer: SshPeer, signal: AbortSignal): Promise<SshBridgeChannel> {
        this.#abort.signal.throwIfAborted();
        signal.throwIfAborted();
        if (this.#channels.size + this.#pendingChannels >= MAXIMUM_CHANNELS) {
            throw new Error("Too many SSH P2P bridges are already open.");
        }
        this.#pendingChannels += 1;
        const linked = linkSignals(this.#abort.signal, signal);
        let channel: SshBridgeChannel;
        try {
            channel = await withDeadline(
                this.#openChannel(peer.ssh, linked.signal),
                this.#connectTimeoutMs,
                "The SSH P2P bridge did not start in time.",
                linked.abort,
            );
        } catch (error) {
            linked.dispose();
            this.#setPeerStatus(peer, "unreachable", { error: errorToMessage(error) });
            throw error;
        } finally {
            this.#pendingChannels -= 1;
        }
        this.#channels.add(channel);
        const abandon = () => this.#releaseChannel(channel);
        linked.signal.addEventListener("abort", abandon, { once: true });
        try {
            await withDeadline(
                this.#runHello(peer, channel),
                HANDSHAKE_TIMEOUT_MS,
                "The SSH P2P bridge did not finish its signed hello in time.",
                () => channel.close(),
            );
            return channel;
        } catch (error) {
            this.#releaseChannel(channel);
            this.#setPeerStatus(peer, "unreachable", { error: describeFailure(error, channel) });
            throw error;
        } finally {
            linked.signal.removeEventListener("abort", abandon);
            linked.dispose();
        }
    }

    async #runHello(peer: SshPeer, channel: SshBridgeChannel): Promise<void> {
        const channelBinding = sshChannelBinding(channel.hostKeyHash);
        await writeBytes(channel.duplex.send, encodeSshBridgePreface(channel.hostKeyHash));
        const identity = await runP2pInitiatorHello(channel.duplex, {
            commitPeer: (peerIdentity) =>
                this.#commitAuthenticatedPeer(peerIdentity, channelBinding),
            identity: this.#identity,
            localChannelBinding: channelBinding,
            remoteChannelBinding: channelBinding,
            transport: "ssh",
            validatePeer: (peerIdentity) =>
                this.#validateAuthenticatedPeer(peerIdentity, channelBinding, peer),
        });
        if (identity.instanceId !== peer.instanceId) {
            throw new Error("The SSH bridge belongs to another Rig instance.");
        }
    }

    async #validateAuthenticatedPeer(
        identity: P2pPeerIdentity,
        channelBinding: string,
        expected: SshPeer,
    ): Promise<void> {
        if (
            identity.instanceId !== expected.instanceId ||
            identity.publicKey !== expected.publicKey
        ) {
            throw new Error("The SSH P2P peer identity does not match its allowlist.");
        }
        await this.#validatePeer?.(identity, channelBinding);
    }

    async #commitAuthenticatedPeer(
        identity: P2pPeerIdentity,
        channelBinding: string,
    ): Promise<void> {
        await this.#commitPeer?.(identity, channelBinding);
    }

    #releaseChannel(channel: SshBridgeChannel): void {
        if (!this.#channels.delete(channel)) return;
        channel.close();
    }

    #setPeerStatus(
        peer: SshPeer,
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
}

/**
 * Builds the versioned preface the remote bridge reads before the signed hello:
 * one version byte followed by the raw verified host-key hash.
 */
export function encodeSshBridgePreface(hostKeyHash: Uint8Array): Uint8Array {
    assertHostKeyHash(hostKeyHash);
    const preface = new Uint8Array(SSH_BRIDGE_PREFACE_BYTES);
    preface[0] = SSH_BRIDGE_PREFACE_VERSION;
    preface.set(hostKeyHash, 1);
    return preface;
}

/** Reads the preface a bridge responder receives, returning the host-key hash. */
export async function readSshBridgePreface(recv: P2pFrameReader): Promise<Uint8Array> {
    const preface = await readBytes(recv, SSH_BRIDGE_PREFACE_BYTES);
    if (preface[0] !== SSH_BRIDGE_PREFACE_VERSION) {
        throw new Error("The SSH P2P bridge preface uses an unsupported version.");
    }
    return preface.subarray(1);
}

/** Turns a verified host-key hash into the value both ends sign into the hello. */
export function sshChannelBinding(hostKeyHash: Uint8Array): string {
    assertHostKeyHash(hostKeyHash);
    return encodeBase64Url(hostKeyHash);
}

function assertHostKeyHash(hostKeyHash: Uint8Array): void {
    if (hostKeyHash.byteLength !== SSH_HOST_KEY_HASH_BYTES) {
        throw new Error("An SSH P2P host-key hash must be 32 bytes.");
    }
}

export function formatSshAddress(peer: P2pSshPeer): string {
    return `${peer.username}@${peer.host}:${peer.port}`;
}

/** Runs `<remoteRig> p2p bridge --stdio` over a freshly authenticated SSH connection. */
export async function openSshBridgeChannel(
    peer: P2pSshPeer,
    signal: AbortSignal,
    options: { connectTimeoutMs?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<SshBridgeChannel> {
    const loaded = await loadSshClientConfig(
        peer,
        options.environment ?? /* istanbul ignore next */ process.env,
    );
    let verifiedHostKeyHash: Uint8Array | undefined;
    const configuredVerifier = loaded.hostVerifier as (fingerprint: string) => boolean;
    const config: ConnectConfig = {
        ...loaded,
        hostVerifier: (fingerprint: string) => {
            if (!configuredVerifier(fingerprint)) return false;
            const hash = Buffer.from(fingerprint, "hex");
            if (hash.byteLength !== SSH_HOST_KEY_HASH_BYTES) return false;
            verifiedHostKeyHash = new Uint8Array(hash);
            return true;
        },
        ...(options.connectTimeoutMs === undefined
            ? {}
            : { readyTimeout: options.connectTimeoutMs }),
    };

    const client = new Client();
    let stderr = "";
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const failed = (error: Error) => finish(error);
        const aborted = () => finish(new Error("The SSH P2P bridge was cancelled."));
        const ready = () => {
            client.exec(
                `${quoteShellArgument(peer.remoteRig)} ${SSH_BRIDGE_ARGUMENTS}`,
                { pty: false },
                (error, stream) => {
                    if (error) return finish(error);
                    stream.stderr.on("data", (chunk: Buffer) => {
                        if (stderr.length >= MAXIMUM_STDERR_BYTES) return;
                        stderr += chunk
                            .toString("utf8")
                            .slice(0, MAXIMUM_STDERR_BYTES - stderr.length);
                    });
                    finish(undefined, stream);
                },
            );
        };
        let settled = false;
        const finish = (error?: Error, stream?: ClientChannel) => {
            if (settled) return;
            settled = true;
            client.off("error", failed);
            client.off("ready", ready);
            signal.removeEventListener("abort", aborted);
            if (error !== undefined || stream === undefined) {
                client.end();
                reject(error ?? new Error("The SSH P2P bridge did not open a stream."));
                return;
            }
            resolve(stream);
        };
        if (signal.aborted) return aborted();
        signal.addEventListener("abort", aborted, { once: true });
        client.once("error", failed);
        client.once("ready", ready);
        client.connect(config);
    });

    if (verifiedHostKeyHash === undefined) {
        client.end();
        throw new Error("The SSH P2P bridge did not verify a host key.");
    }
    return {
        close: () => {
            channel.destroy();
            client.end();
        },
        diagnostics: () => stderr.trim(),
        duplex: createNodeFrameDuplex(channel, channel),
        hostKeyHash: verifiedHostKeyHash,
    };
}

/**
 * The bridge command runs through the remote login shell, so a configured path
 * is passed as one single-quoted word.
 */
function quoteShellArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function describeFailure(error: unknown, channel: SshBridgeChannel): string {
    const message = errorToMessage(error);
    const diagnostics = channel.diagnostics();
    return diagnostics.length === 0
        ? message
        : `${message} The remote command said: ${diagnostics}`;
}

function errorToMessage(error: unknown): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : "The SSH P2P bridge is unreachable.";
}

function linkSignals(
    left: AbortSignal,
    right: AbortSignal,
): { abort: () => void; dispose: () => void; signal: AbortSignal } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const dispose = () => {
        left.removeEventListener("abort", abort);
        right.removeEventListener("abort", abort);
    };
    if (left.aborted || right.aborted) controller.abort();
    else {
        left.addEventListener("abort", abort, { once: true });
        right.addEventListener("abort", abort, { once: true });
    }
    return { abort, dispose, signal: controller.signal };
}

function withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(message));
        }, timeoutMs);
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
