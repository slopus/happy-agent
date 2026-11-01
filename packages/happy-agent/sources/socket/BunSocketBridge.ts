import {
    socketRejectionBody,
    WORKSPACE_PROXY_ROUTE_HEADER,
    type ApiSocketRejection,
    type PreparedWorkspaceProxySocket,
} from "@slopus/happy-agent-modules";
import { Duplex } from "node:stream";

import { unknownTunnelRejection } from "./unknownTunnelRejection.js";

const MAX_HEADER_BYTES = 64 * 1024;
// Ordinary API requests may legally carry a 48 MiB JSON body. The native front door normally
// connects its internal peer before more than a header is buffered, but the hard bound must still
// accommodate one complete legal request when that connection is delayed.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Queued bytes for one side past which the side feeding it stops reading until it drains. */
const OUTBOUND_HIGH_WATER_BYTES = 1024 * 1024;
const HEADER_TIMEOUT_SECONDS = 10;
const CONNECT_TIMEOUT_MS = 30_000;

interface BunSocketListener {
    readonly hostname?: string;
    readonly port?: number;
    stop(closeActiveConnections?: boolean): void;
}

export type BunSocketAddress =
    | { readonly unix: string }
    | { readonly hostname: string; readonly port: number };

interface BunSocket {
    data: SocketState;
    close(): void;
    end(data?: string | Uint8Array): number | void;
    /** Send end of stream while still reading; `end` closes both directions. */
    shutdown?(halfClose?: boolean): void;
    timeout?(seconds: number): void;
    write(data: string | Uint8Array): number;
    pause?(): void;
    resume?(): void;
}

export interface BunRuntime {
    connect(options: Record<string, unknown>): Promise<BunSocket>;
    listen(options: Record<string, unknown>): BunSocketListener;
}

interface OutboundState {
    drained?: ((error?: Error | null) => void) | undefined;
    /** What follows once the queue drains: half-close the write side, or close the socket. */
    finishAfterFlush: "end" | "shutdown" | undefined;
    /** Whether the side that feeds this one was paused because this one's queue is full. */
    feederPaused: boolean;
    outboundBytes: number;
    outboundOffset: number;
    outboundQueue: Buffer[];
}

interface ClientState extends OutboundState {
    remote?: Duplex | undefined;
    buffer: Buffer;
    closed: boolean;
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    kind: "client";
    phase: "connecting" | "headers" | "proxy_headers" | "raw" | "routing";
    /** The workspace proxy route naming the network this attachment's connections come from. */
    proxyRoute: string | undefined;
    /** Stops watching the credential that admitted this tunnel, once the tunnel closes. */
    release?: (() => void) | undefined;
    upstream: BunSocket | undefined;
}

interface PeerState extends OutboundState {
    kind: "peer";
    peer: BunSocket;
}

type SocketState = ClientState | PeerState;

interface ParsedRequestHead {
    readonly headers: Record<string, string | string[]>;
    readonly authorization: string | string[] | undefined;
    readonly bytes: number;
    readonly connection: string | undefined;
    readonly method: string;
    readonly target: string;
    readonly upgrade: string | undefined;
}

export interface BunSocketBridgeOptions {
    readonly forwardAuthenticatedAttachment?: (
        request: { method: string; target: string; headers: Record<string, string | string[]> },
        stream: Duplex,
        head: Buffer,
    ) => Promise<void>;
    readonly httpAddress: BunSocketAddress;
    readonly prepareWorkspaceProxy: (
        pathname: string,
        authorization: string | string[] | undefined,
    ) => Promise<PreparedWorkspaceProxySocket>;
    readonly proxyHttpAddress: BunSocketAddress;
    /** Private, connection-scoped admission for a loopback workspace HTTP listener. */
    readonly proxyHttpAuthorization?: string;
    readonly publicAddress: BunSocketAddress;
}

export interface BunSocketBridge {
    readonly hostname: string | undefined;
    readonly port: number | undefined;
    close(): void;
    drain(gracePeriodMs: number): Promise<void>;
}

export function startBunSocketBridge(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
): BunSocketBridge {
    const connections = new Set<BunSocket>();
    let onDrained: (() => void) | undefined;
    const listener = bun.listen({
        allowHalfOpen: true,
        ...options.publicAddress,
        socket: {
            open(socket: BunSocket) {
                connections.add(socket);
                socket.data = clientState();
                socket.timeout?.(HEADER_TIMEOUT_SECONDS);
            },
            data(socket: BunSocket, data: Uint8Array) {
                receiveClientData(bun, options, socket, Buffer.from(data));
            },
            drain(socket: BunSocket) {
                flushOutbound(socket);
            },
            end(socket: BunSocket) {
                const remote = clientStateOf(socket).remote;
                if (remote !== undefined) {
                    remote.push(null);
                    return;
                }
                const upstream = clientUpstream(socket);
                if (upstream !== undefined) finishOutbound(upstream, "shutdown");
            },
            close(socket: BunSocket) {
                closeClientState(socket);
                connections.delete(socket);
                if (connections.size === 0) onDrained?.();
            },
            error(socket: BunSocket) {
                closeBridge(socket);
            },
            timeout(socket: BunSocket) {
                closeBridge(socket);
            },
        },
    });
    return {
        hostname: listener.hostname,
        port: listener.port,
        close: () => {
            listener.stop(true);
            onDrained?.();
        },
        drain: async (gracePeriodMs) =>
            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    onDrained = undefined;
                    resolve();
                };
                const timer = setTimeout(() => {
                    listener.stop(true);
                    done();
                }, gracePeriodMs);
                timer.unref();
                onDrained = done;
                listener.stop(false);
                if (connections.size === 0) done();
            }),
    };
}

function receiveClientData(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
    socket: BunSocket,
    data: Buffer,
): void {
    const state = clientStateOf(socket);
    if (state.closed) return;
    if (state.remote !== undefined) {
        if (state.remote.readableLength + data.length > MAX_BUFFERED_BYTES) {
            closeBridge(socket);
            return;
        }
        if (!state.remote.push(data)) socket.pause?.();
        return;
    }
    if (state.phase === "raw" && state.upstream !== undefined) {
        enqueueWrite(state.upstream, data);
        return;
    }
    state.buffer = Buffer.concat([state.buffer, data]);
    if (state.buffer.byteLength > MAX_BUFFERED_BYTES) {
        closeBridge(socket);
        return;
    }
    if (state.phase === "headers") routeInitialRequest(bun, options, socket);
    else if (state.phase === "proxy_headers") routeProxyRequest(bun, options, socket);
}

function routeInitialRequest(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
    socket: BunSocket,
): void {
    const state = clientStateOf(socket);
    const parsed = parseRequestHead(state.buffer);
    if (parsed === undefined) {
        if (state.buffer.byteLength > MAX_HEADER_BYTES)
            refuse(socket, 431, "Request Header Fields Too Large");
        return;
    }
    state.phase = "routing";
    socket.timeout?.(0);
    const pathname = requestPathname(parsed.target);
    // Bun's node:http server does not own native upgrade/CONNECT sockets. Give the
    // shared authenticated API gateway a Duplex over this native socket instead.
    if (
        pathname?.startsWith("/v0/connections/") === true &&
        options.forwardAuthenticatedAttachment !== undefined &&
        (parsed.method === "CONNECT" || parsed.upgrade?.toLowerCase() === "websocket")
    ) {
        const remote = new Duplex({
            allowHalfOpen: true,
            read() {
                socket.resume?.();
            },
            write(chunk: Buffer, _encoding, callback) {
                enqueueWrite(socket, chunk);
                if (state.closed) callback(new Error("The remote attachment closed."));
                else if (state.outboundBytes === 0) callback();
                else state.drained = callback;
            },
            final(callback) {
                finishOutbound(socket);
                callback();
            },
            destroy(error, callback) {
                const drained = state.drained;
                state.drained = undefined;
                drained?.(error ?? new Error("The remote attachment closed."));
                closeBridge(socket);
                callback(error);
            },
        });
        remote.on("error", () => closeBridge(socket));
        state.remote = remote;
        state.phase = "raw";
        const head = state.buffer.subarray(parsed.bytes);
        state.buffer = Buffer.alloc(0);
        void options
            .forwardAuthenticatedAttachment(parsed, remote, head)
            .catch(() => closeBridge(socket));
        return;
    }
    if (parsed.method === "CONNECT" && pathname !== undefined) {
        void options
            .prepareWorkspaceProxy(pathname, parsed.authorization)
            .then((prepared) => {
                if (state.closed) return;
                if (!prepared.handled) {
                    // Native HTTP cannot carry a tunnel request: it answered one with a 500 and
                    // held the connection open, so a client waiting for the refusal hung.
                    rejectSocket(socket, unknownTunnelRejection);
                    return;
                }
                if ("rejection" in prepared) {
                    rejectSocket(socket, prepared.rejection);
                    return;
                }
                const revoked = prepared.revoked;
                if (revoked?.aborted === true) {
                    closeBridge(socket);
                    return;
                }
                if (revoked !== undefined) {
                    // A withdrawn credential, such as a removed phone's, ends its tunnel at once.
                    const close = () => closeBridge(socket);
                    revoked.addEventListener("abort", close, { once: true });
                    state.release = () => revoked.removeEventListener("abort", close);
                }
                state.buffer = state.buffer.subarray(parsed.bytes);
                state.phase = "proxy_headers";
                state.proxyRoute = prepared.route;
                enqueueWrite(socket, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
                socket.timeout?.(HEADER_TIMEOUT_SECONDS);
                if (state.buffer.byteLength > 0) routeProxyRequest(bun, options, socket);
            })
            .catch(() => refuse(socket, 500, "Internal Server Error"));
        return;
    }
    // Native Bun HTTP owns every ordinary request and local WebSocket upgrade, including
    // later requests on a keep-alive connection. Only raw tunnels are handled above.
    connectPeer(bun, socket, options.httpAddress);
}

function routeProxyRequest(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
    socket: BunSocket,
): void {
    const state = clientStateOf(socket);
    const parsed = parseRequestHead(state.buffer);
    if (parsed === undefined) {
        if (state.buffer.byteLength > MAX_HEADER_BYTES)
            refuse(socket, 431, "Request Header Fields Too Large");
        return;
    }
    state.phase = "connecting";
    socket.timeout?.(0);
    const route = state.proxyRoute;
    if (route === undefined) {
        refuse(socket, 502, "Bad Gateway");
        return;
    }
    // Every request and tunnel goes to the internal proxy listener with the attachment's route,
    // which opens it from the workspace's network. Nothing here connects to a target directly.
    // Only the first inner request is inspected. The admitted internal connection then owns
    // ordinary HTTP framing and keep-alive, just like the Unix listener.
    const lines = state.buffer
        .subarray(0, parsed.bytes - 4)
        .toString("latin1")
        .split("\r\n");
    const head = lines.filter(
        (line) =>
            !/^proxy-authorization\s*:/i.test(line) &&
            !line.toLowerCase().startsWith(`${WORKSPACE_PROXY_ROUTE_HEADER}:`),
    );
    if (options.proxyHttpAuthorization !== undefined)
        head.push(`Proxy-Authorization: ${options.proxyHttpAuthorization}`);
    head.push(`${WORKSPACE_PROXY_ROUTE_HEADER}: ${route}`);
    state.buffer = Buffer.concat([
        Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "latin1"),
        state.buffer.subarray(parsed.bytes),
    ]);
    connectPeer(bun, socket, options.proxyHttpAddress);
}

function connectPeer(bun: BunRuntime, client: BunSocket, address: BunSocketAddress): void {
    const state = clientStateOf(client);
    state.phase = "connecting";
    state.connectTimer = setTimeout(() => {
        state.connectTimer = undefined;
        refuse(client, 504, "Gateway Timeout");
    }, CONNECT_TIMEOUT_MS);
    state.connectTimer.unref?.();
    void bun
        .connect({
            ...address,
            allowHalfOpen: true,
            data: peerState(client),
            socket: {
                open(upstream: BunSocket) {
                    if (state.closed) {
                        upstream.close();
                        return;
                    }
                    clearConnectTimer(state);
                    state.upstream = upstream;
                    state.phase = "raw";
                    const initial = state.buffer;
                    state.buffer = Buffer.alloc(0);
                    if (initial.byteLength > 0) enqueueWrite(upstream, initial);
                },
                data(upstream: BunSocket, data: Uint8Array) {
                    enqueueWrite(peerStateOf(upstream).peer, Buffer.from(data));
                },
                drain(upstream: BunSocket) {
                    flushOutbound(upstream);
                },
                end(upstream: BunSocket) {
                    finishOutbound(peerStateOf(upstream).peer, "shutdown");
                },
                close(upstream: BunSocket) {
                    const peer = peerStateOf(upstream).peer;
                    const peerState = clientStateOf(peer);
                    if (peerState.upstream === upstream) peerState.upstream = undefined;
                    finishOutbound(peer);
                },
                error(upstream: BunSocket) {
                    closeBridge(peerStateOf(upstream).peer);
                },
                connectError(upstream: BunSocket) {
                    const peer = peerStateOf(upstream).peer;
                    clearConnectTimer(clientStateOf(peer));
                    refuse(peer, 502, "Bad Gateway");
                },
                timeout(upstream: BunSocket) {
                    closeBridge(peerStateOf(upstream).peer);
                },
            },
        })
        .catch(() => {
            clearConnectTimer(state);
            if (!state.closed) refuse(client, 502, "Bad Gateway");
        });
}

function parseRequestHead(buffer: Buffer): ParsedRequestHead | undefined {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker < 0) return undefined;
    const bytes = marker + 4;
    const lines = buffer.subarray(0, marker).toString("latin1").split("\r\n");
    const requestLine = /^(\S+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
    if (requestLine === null) return invalidParsedHead(bytes);
    const headers = new Map<string, string | string[]>();
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator <= 0) return invalidParsedHead(bytes);
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const existing = headers.get(name);
        if (existing === undefined) headers.set(name, value);
        else if (Array.isArray(existing)) existing.push(value);
        else headers.set(name, [existing, value]);
    }
    return {
        headers: Object.fromEntries(headers),
        authorization: headers.get("authorization"),
        bytes,
        connection: singleHeader(headers.get("connection")),
        method: requestLine[1] as string,
        target: requestLine[2] as string,
        upgrade: singleHeader(headers.get("upgrade")),
    };
}

function invalidParsedHead(bytes: number): ParsedRequestHead {
    return {
        headers: {},
        authorization: undefined,
        bytes,
        connection: undefined,
        method: "INVALID",
        target: "/",
        upgrade: undefined,
    };
}

function requestPathname(target: string): string | undefined {
    try {
        return new URL(target, "http://happy-agent.invalid").pathname;
    } catch {
        return undefined;
    }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function rejectSocket(socket: BunSocket, rejection: ApiSocketRejection): void {
    const body = JSON.stringify(socketRejectionBody(rejection));
    endWith(
        socket,
        `HTTP/1.1 ${String(rejection.status)} ${statusText(rejection.status)}\r\n` +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\n" +
            `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
            "Connection: close\r\n\r\n" +
            body,
    );
}

function refuse(socket: BunSocket, status: number, text: string): void {
    endWith(
        socket,
        `HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

function statusText(status: number): string {
    if (status === 400) return "Bad Request";
    if (status === 401) return "Unauthorized";
    if (status === 404) return "Not Found";
    if (status === 409) return "Conflict";
    if (status === 413) return "Content Too Large";
    if (status === 501) return "Not Implemented";
    if (status === 503) return "Service Unavailable";
    return "Internal Server Error";
}

function endWith(socket: BunSocket, value: string | Buffer): void {
    enqueueWrite(socket, Buffer.from(value));
    finishOutbound(socket);
}

function enqueueWrite(socket: BunSocket, data: Buffer): void {
    if (data.byteLength === 0) return;
    const state = outboundStateOf(socket);
    if (state.outboundBytes + data.byteLength > MAX_BUFFERED_BYTES) {
        closeBridge(socket);
        return;
    }
    if (state.outboundQueue.length === 0) {
        const written = socket.write(data);
        if (written < 0) {
            closeBridge(socket);
            return;
        }
        if (written >= data.byteLength) return;
        state.outboundQueue.push(data);
        state.outboundOffset = written;
        state.outboundBytes = data.byteLength - written;
    } else {
        state.outboundQueue.push(data);
        state.outboundBytes += data.byteLength;
    }
    if (state.outboundBytes > OUTBOUND_HIGH_WATER_BYTES && !state.feederPaused) {
        state.feederPaused = true;
        feederOf(socket)?.pause?.();
    }
}

function flushOutbound(socket: BunSocket): void {
    const state = outboundStateOf(socket);
    while (state.outboundQueue.length > 0) {
        const current = state.outboundQueue[0] as Buffer;
        const remaining = current.subarray(state.outboundOffset);
        const written = socket.write(remaining);
        if (written < 0) {
            closeBridge(socket);
            return;
        }
        if (written === 0) return;
        state.outboundOffset += written;
        state.outboundBytes -= written;
        if (state.outboundOffset < current.byteLength) return;
        state.outboundQueue.shift();
        state.outboundOffset = 0;
    }
    if (state.feederPaused) {
        state.feederPaused = false;
        feederOf(socket)?.resume?.();
    }
    const how = state.finishAfterFlush;
    state.finishAfterFlush = undefined;
    if (how !== undefined) finish(socket, how);
    const drained = state.drained;
    state.drained = undefined;
    drained?.();
}

/**
 * End this side once everything queued for it is written. A forwarded end of stream only
 * half-closes, so the other direction keeps flowing; Bun's `end` would close both.
 */
function finishOutbound(socket: BunSocket, how: "end" | "shutdown" = "end"): void {
    const state = outboundStateOf(socket);
    if (state.outboundQueue.length === 0) finish(socket, how);
    else if (state.finishAfterFlush !== "end") state.finishAfterFlush = how;
}

function finish(socket: BunSocket, how: "end" | "shutdown"): void {
    if (how === "shutdown" && socket.shutdown !== undefined) socket.shutdown();
    else socket.end();
}

function closeBridge(socket: BunSocket): void {
    const state = socket.data;
    if (state.kind === "client") {
        if (state.closed) return;
        state.closed = true;
        releaseClientState(state);
        state.remote?.destroy();
        clearConnectTimer(state);
        const upstream = state.upstream;
        state.upstream = undefined;
        upstream?.close();
    } else {
        const peer = state.peer;
        const peerState = clientStateOf(peer);
        if (peerState.upstream === socket) peerState.upstream = undefined;
        if (!peerState.closed) {
            peerState.closed = true;
            clearConnectTimer(peerState);
            peer.close();
        }
    }
    socket.close();
}

function closeClientState(socket: BunSocket): void {
    const state = clientStateOf(socket);
    if (state.closed) return;
    state.closed = true;
    releaseClientState(state);
    state.remote?.destroy();
    clearConnectTimer(state);
    const upstream = state.upstream;
    state.upstream = undefined;
    upstream?.close();
}

function releaseClientState(state: ClientState): void {
    const release = state.release;
    state.release = undefined;
    release?.();
}

function clearConnectTimer(state: ClientState): void {
    if (state.connectTimer === undefined) return;
    clearTimeout(state.connectTimer);
    state.connectTimer = undefined;
}

/** The socket whose data is written to this one: a client's upstream, or a peer's client. */
function feederOf(socket: BunSocket): BunSocket | undefined {
    return socket.data.kind === "client" ? socket.data.upstream : socket.data.peer;
}

function clientUpstream(socket: BunSocket): BunSocket | undefined {
    return socket.data.kind === "client" ? socket.data.upstream : undefined;
}

function clientState(): ClientState {
    return {
        buffer: Buffer.alloc(0),
        closed: false,
        connectTimer: undefined,
        finishAfterFlush: undefined,
        feederPaused: false,
        kind: "client",
        outboundBytes: 0,
        outboundOffset: 0,
        outboundQueue: [],
        phase: "headers",
        proxyRoute: undefined,
        upstream: undefined,
    };
}

function peerState(peer: BunSocket): PeerState {
    return {
        finishAfterFlush: undefined,
        feederPaused: false,
        kind: "peer",
        outboundBytes: 0,
        outboundOffset: 0,
        outboundQueue: [],
        peer,
    };
}

function clientStateOf(socket: BunSocket): ClientState {
    if (socket.data.kind !== "client") throw new Error("Expected a Bun client socket.");
    return socket.data;
}

function peerStateOf(socket: BunSocket): PeerState {
    if (socket.data.kind !== "peer") throw new Error("Expected a Bun peer socket.");
    return socket.data;
}

function outboundStateOf(socket: BunSocket): OutboundState {
    return socket.data;
}
