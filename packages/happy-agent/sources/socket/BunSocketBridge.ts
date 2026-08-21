import type { ApiSocketRejection, PreparedWorkspaceProxySocket } from "@slopus/happy-agent-modules";

const MAX_HEADER_BYTES = 64 * 1024;
// Ordinary API requests may legally carry a 48 MiB JSON body. The native front door normally
// connects its internal peer before more than a header is buffered, but the hard bound must still
// accommodate one complete legal request when that connection is delayed.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const HEADER_TIMEOUT_SECONDS = 10;
const CONNECT_TIMEOUT_MS = 30_000;

interface BunSocketListener {
    stop(closeActiveConnections?: boolean): void;
}

interface BunSocket {
    data: SocketState;
    close(): void;
    end(data?: string | Uint8Array): number | void;
    timeout?(seconds: number): void;
    write(data: string | Uint8Array): number;
}

export interface BunRuntime {
    connect(options: Record<string, unknown>): Promise<BunSocket>;
    listen(options: Record<string, unknown>): BunSocketListener;
}

interface OutboundState {
    endAfterFlush: boolean;
    outboundBytes: number;
    outboundOffset: number;
    outboundQueue: Buffer[];
}

interface ClientState extends OutboundState {
    buffer: Buffer;
    closed: boolean;
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    kind: "client";
    phase: "connecting" | "headers" | "proxy_headers" | "raw" | "routing";
    upstream: BunSocket | undefined;
}

interface PeerState extends OutboundState {
    kind: "peer";
    peer: BunSocket;
}

type SocketState = ClientState | PeerState;

interface ParsedRequestHead {
    readonly authorization: string | string[] | undefined;
    readonly bytes: number;
    readonly connection: string | undefined;
    readonly method: string;
    readonly target: string;
    readonly upgrade: string | undefined;
}

export interface BunSocketBridgeOptions {
    readonly httpSocketPath: string;
    readonly prepareWorkspaceProxy: (
        pathname: string,
        authorization: string | string[] | undefined,
    ) => Promise<PreparedWorkspaceProxySocket>;
    readonly proxyHttpSocketPath: string;
    readonly publicSocketPath: string;
    readonly webSocketPath: string;
}

export interface BunSocketBridge {
    close(): void;
}

export function startBunSocketBridge(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
): BunSocketBridge {
    const listener = bun.listen({
        allowHalfOpen: true,
        unix: options.publicSocketPath,
        socket: {
            open(socket: BunSocket) {
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
                const upstream = clientUpstream(socket);
                if (upstream !== undefined) finishOutbound(upstream);
            },
            close(socket: BunSocket) {
                closeClientState(socket);
            },
            error(socket: BunSocket) {
                closeBridge(socket);
            },
            timeout(socket: BunSocket) {
                closeBridge(socket);
            },
        },
    });
    return { close: () => listener.stop(true) };
}

function receiveClientData(
    bun: BunRuntime,
    options: BunSocketBridgeOptions,
    socket: BunSocket,
    data: Buffer,
): void {
    const state = clientStateOf(socket);
    if (state.closed) return;
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
    if (parsed.method === "CONNECT" && pathname !== undefined) {
        void options
            .prepareWorkspaceProxy(pathname, parsed.authorization)
            .then((prepared) => {
                if (state.closed) return;
                if (!prepared.handled) {
                    connectUnixPeer(bun, socket, options.httpSocketPath);
                    return;
                }
                if ("rejection" in prepared) {
                    rejectSocket(socket, prepared.rejection);
                    return;
                }
                state.buffer = state.buffer.subarray(parsed.bytes);
                state.phase = "proxy_headers";
                enqueueWrite(socket, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
                socket.timeout?.(HEADER_TIMEOUT_SECONDS);
                if (state.buffer.byteLength > 0) routeProxyRequest(bun, options, socket);
            })
            .catch(() => refuse(socket, 500, "Internal Server Error"));
        return;
    }
    const webSocket =
        parsed.method === "GET" &&
        parsed.upgrade?.toLowerCase() === "websocket" &&
        parsed.connection
            ?.toLowerCase()
            .split(",")
            .some((value) => value.trim() === "upgrade") === true;
    connectUnixPeer(bun, socket, webSocket ? options.webSocketPath : options.httpSocketPath);
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
    if (parsed.method !== "CONNECT") {
        connectUnixPeer(bun, socket, options.proxyHttpSocketPath);
        return;
    }
    let target: URL;
    try {
        target = new URL(`http://${parsed.target}`);
    } catch {
        refuse(socket, 400, "Bad Request");
        return;
    }
    const port = target.port === "" ? 80 : Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || target.hostname.length === 0) {
        refuse(socket, 400, "Bad Request");
        return;
    }
    state.buffer = state.buffer.subarray(parsed.bytes);
    connectTcpPeer(bun, socket, target.hostname, port);
}

function connectUnixPeer(bun: BunRuntime, client: BunSocket, path: string): void {
    connectPeer(bun, client, { unix: path }, () => undefined);
}

function connectTcpPeer(bun: BunRuntime, client: BunSocket, hostname: string, port: number): void {
    connectPeer(bun, client, { hostname, port }, () => {
        enqueueWrite(client, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
    });
}

function connectPeer(
    bun: BunRuntime,
    client: BunSocket,
    address: { readonly unix: string } | { readonly hostname: string; readonly port: number },
    connected: () => void,
): void {
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
                    connected();
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
                    finishOutbound(peerStateOf(upstream).peer);
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
    const body = JSON.stringify({ error: rejection.message, code: rejection.code });
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
        return;
    }
    state.outboundQueue.push(data);
    state.outboundBytes += data.byteLength;
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
    if (state.endAfterFlush) socket.end();
}

function finishOutbound(socket: BunSocket): void {
    const state = outboundStateOf(socket);
    if (state.outboundQueue.length === 0) socket.end();
    else state.endAfterFlush = true;
}

function closeBridge(socket: BunSocket): void {
    const state = socket.data;
    if (state.kind === "client") {
        if (state.closed) return;
        state.closed = true;
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
    clearConnectTimer(state);
    const upstream = state.upstream;
    state.upstream = undefined;
    upstream?.close();
}

function clearConnectTimer(state: ClientState): void {
    if (state.connectTimer === undefined) return;
    clearTimeout(state.connectTimer);
    state.connectTimer = undefined;
}

function clientUpstream(socket: BunSocket): BunSocket | undefined {
    return socket.data.kind === "client" ? socket.data.upstream : undefined;
}

function clientState(): ClientState {
    return {
        buffer: Buffer.alloc(0),
        closed: false,
        connectTimer: undefined,
        endAfterFlush: false,
        kind: "client",
        outboundBytes: 0,
        outboundOffset: 0,
        outboundQueue: [],
        phase: "headers",
        upstream: undefined,
    };
}

function peerState(peer: BunSocket): PeerState {
    return {
        endAfterFlush: false,
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
