import { chmod, unlink } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    createServer,
    request as requestHttp,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type OutgoingHttpHeaders,
    type Server,
    type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { streamToOutgoing } from "../transport/index.js";

/** How long opening one connection may take. Nothing bounds a connection once it is open. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** How long one request's headers may take to arrive. Its body and its response are unbounded. */
const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;
/** How often the listeners look for requests whose headers are overdue. */
const HEADERS_CHECK_INTERVAL_MS = 30_000;
/** How long a route waits for the attachment it was made for before it is forgotten. */
const ROUTE_TTL_MS = 60_000;
/** Carries a route from the Bun front door to this listener; never forwarded upstream. */
export const WORKSPACE_PROXY_ROUTE_HEADER = "x-happy-proxy-route";
/** Headers that describe one hop's connection, not the request, and are never forwarded. */
const HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    WORKSPACE_PROXY_ROUTE_HEADER,
]);

/** Opens a connection from the workspace's own network. */
export type WorkspaceProxyConnector = (
    host: string,
    port: number,
    hostAsWritten: string,
) => Promise<Duplex>;

/** An admitted route refused this destination before connecting. */
export class WorkspaceProxyPolicyError extends Error {
    constructor() {
        super("The artifact does not allow this destination.");
        this.name = "WorkspaceProxyPolicyError";
    }
}

/** The loopback TCP hop Bun front doors forward workspace tunnels to, and how they are admitted. */
export interface WorkspaceProxyTcpHop {
    readonly port: number;
    /** The `Proxy-Authorization` value the front door adds to each connection's first request. */
    readonly authorization: string;
}

export interface WorkspaceProxyOptions {
    /** Overrides the 30-second bound on opening one connection. */
    readonly connectTimeoutMs?: number;
    /** Overrides the 60-second bound on receiving one request's headers. */
    readonly headersTimeoutMs?: number;
}

/**
 * HTTP/1.1 forward proxy spoken inside a workspace CONNECT attachment.
 *
 * Every attachment is admitted with a route: a one-time key naming the network its connections are
 * opened from — this machine, a runner, or one agent's machine. Every request and tunnel on that
 * attachment opens its connection through that route and nowhere else. A request that arrives
 * without a route is refused; it is never connected from this process's own network instead.
 *
 * Once a connection is open, bytes flow in both directions for as long as both sides keep it
 * open, with backpressure and half-close passed through. Only opening a connection is bounded.
 */
export class WorkspaceProxy {
    /** Attachments handed over directly, and the private Unix socket. Both are owner-only. */
    readonly #server: Server;
    /**
     * Loopback TCP, which any local process can reach, so each connection is admitted by a
     * memory-only credential. Every front door shares this one hop.
     */
    readonly #tcpServer: Server;
    readonly #connectTimeoutMs: number;
    readonly #sockets = new Set<Duplex>();
    #socketPath: string | undefined;
    #tcpHop: Promise<WorkspaceProxyTcpHop> | undefined;
    #tcpToken: string | undefined;
    readonly #admitted = new WeakSet<Duplex>();
    readonly #connectors = new WeakMap<Duplex, WorkspaceProxyConnector>();
    readonly #routes = new Map<
        string,
        { readonly connector: WorkspaceProxyConnector; readonly timer: NodeJS.Timeout }
    >();

    constructor(options: WorkspaceProxyOptions = {}) {
        this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        // Node bounds headers by the request timeout unless told otherwise, and a request here
        // is never bounded, so a client that never finishes its headers would hold on forever.
        const headersTimeout = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
        const bounds = {
            requestTimeout: 0,
            headersTimeout,
            connectionsCheckingInterval: Math.min(HEADERS_CHECK_INTERVAL_MS, headersTimeout),
        };
        this.#server = createServer(bounds);
        this.#tcpServer = createServer(bounds);
        this.#serve(this.#server, false);
        this.#serve(this.#tcpServer, true);
    }

    #serve(server: Server, admitted: boolean): void {
        server.on("request", (request, response) => {
            if (admitted && !this.#admit(request)) {
                sendProxyError(response, 407, "Proxy authentication is required.");
                return;
            }
            this.#forwardRequest(request, response);
        });
        server.on("connect", (request, socket, head) => {
            if (admitted && !this.#admit(request)) {
                refuse(socket, 407, "Proxy Authentication Required");
                return;
            }
            this.#openTunnel(request, socket, head);
        });
        server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => {
                this.#sockets.delete(socket);
            });
        });
        server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
            if (error.code === "ERR_HTTP_REQUEST_TIMEOUT") refuse(socket, 408, "Request Timeout");
            else refuse(socket, 400, "Bad Request");
        });
    }

    /**
     * Registers how one attachment's connections are made, returning the one-time key that
     * attachment presents. A key nobody presents within a minute is forgotten.
     */
    route(connector: WorkspaceProxyConnector): string {
        const key = randomBytes(24).toString("base64url");
        const timer = setTimeout(() => this.#routes.delete(key), ROUTE_TTL_MS);
        timer.unref();
        this.#routes.set(key, { connector, timer });
        return key;
    }

    /** Open an admitted attachment on this socket, connecting only through its route. */
    accept(socket: Socket, head: Buffer, route: string): void {
        const connector = this.#take(route);
        if (connector === undefined) {
            refuse(socket, 502, "Bad Gateway");
            return;
        }
        this.#connectors.set(socket, connector);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
            if (head.byteLength > 0) socket.unshift(head);
            this.#server.emit("connection", socket);
            socket.resume();
        });
    }

    /**
     * Open an admitted attachment that is already a byte stream, such as a WebSocket tunnel. It
     * has no `CONNECT` to answer; its bytes are the proxy conversation from the start. Returns
     * `false`, opening nothing, when the route is unknown or expired.
     */
    acceptStream(stream: Duplex, route: string): boolean {
        const connector = this.#take(route);
        if (connector === undefined) return false;
        this.#connectors.set(stream, connector);
        this.#server.emit("connection", stream);
        return true;
    }

    async listen(path: string): Promise<void> {
        if (this.#socketPath !== undefined) {
            if (this.#socketPath === path) return;
            throw new Error("The workspace HTTP proxy is already listening.");
        }
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => {
                this.#server.off("listening", listening);
                reject(error);
            };
            const listening = (): void => {
                this.#server.off("error", failed);
                resolve();
            };
            this.#server.once("error", failed);
            this.#server.once("listening", listening);
            this.#server.listen(path);
        });
        this.#socketPath = path;
        await chmod(path, 0o600);
    }

    /**
     * The loopback TCP hop for Bun front doors, opened on first use. Every caller receives the same
     * hop, so a second front door beside the first, Unix socket or not, shares it.
     */
    async listenTcp(): Promise<WorkspaceProxyTcpHop> {
        this.#tcpHop ??= this.#openTcp();
        try {
            return await this.#tcpHop;
        } catch (error) {
            this.#tcpHop = undefined;
            throw error;
        }
    }

    async #openTcp(): Promise<WorkspaceProxyTcpHop> {
        const token = randomBytes(32).toString("base64url");
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => {
                this.#tcpServer.off("listening", listening);
                reject(error);
            };
            const listening = (): void => {
                this.#tcpServer.off("error", failed);
                resolve();
            };
            this.#tcpServer.once("error", failed);
            this.#tcpServer.once("listening", listening);
            this.#tcpServer.listen({ host: "127.0.0.1", port: 0 });
        });
        const address = this.#tcpServer.address();
        if (address === null || typeof address === "string") {
            throw new Error("The workspace HTTP proxy is not listening on TCP.");
        }
        this.#tcpToken = token;
        return { port: address.port, authorization: `Bearer ${token}` };
    }

    #admit(request: IncomingMessage): boolean {
        const token = this.#tcpToken;
        if (token === undefined) return false;
        const authorization = request.headers["proxy-authorization"];
        delete request.headers["proxy-authorization"];
        if (this.#admitted.has(request.socket)) return true;
        const expected = `Bearer ${token}`;
        if (
            typeof authorization !== "string" ||
            Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
        )
            return false;
        this.#admitted.add(request.socket);
        return true;
    }

    #take(route: string): WorkspaceProxyConnector | undefined {
        const entry = this.#routes.get(route);
        if (entry === undefined) return undefined;
        this.#routes.delete(route);
        clearTimeout(entry.timer);
        return entry.connector;
    }

    /** The network this request's connection is opened from; undefined when it has no route. */
    #connectorFor(request: IncomingMessage): WorkspaceProxyConnector | undefined {
        const route = request.headers[WORKSPACE_PROXY_ROUTE_HEADER];
        delete request.headers[WORKSPACE_PROXY_ROUTE_HEADER];
        const existing = this.#connectors.get(request.socket);
        if (existing !== undefined || typeof route !== "string") return existing;
        const connector = this.#take(route);
        if (connector !== undefined) this.#connectors.set(request.socket, connector);
        return connector;
    }

    /** Open one connection through a route, bounded only until it is established. */
    async #open(
        connector: WorkspaceProxyConnector,
        host: string,
        port: number,
        hostAsWritten: string,
    ): Promise<Duplex> {
        return await new Promise<Duplex>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                settled = true;
                reject(new ConnectTimeoutError());
            }, this.#connectTimeoutMs);
            timer.unref();
            connector(host, port, hostAsWritten).then(
                (opened) => {
                    clearTimeout(timer);
                    // Whoever takes the connection adds its own handling; until then, and for a
                    // connection opened too late, an error must only close it.
                    opened.on("error", () => undefined);
                    if (settled) {
                        opened.destroy();
                        return;
                    }
                    settled = true;
                    resolve(opened);
                },
                (error: unknown) => {
                    clearTimeout(timer);
                    if (settled) return;
                    settled = true;
                    reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    async close(): Promise<void> {
        for (const { timer } of this.#routes.values()) clearTimeout(timer);
        this.#routes.clear();
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        const path = this.#socketPath;
        this.#socketPath = undefined;
        this.#tcpHop = undefined;
        this.#tcpToken = undefined;
        await Promise.all([closeServer(this.#server), closeServer(this.#tcpServer)]);
        if (path === undefined) return;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }

    #forwardRequest(request: IncomingMessage, response: ServerResponse): void {
        let target: URL;
        try {
            target = new URL(request.url ?? "");
        } catch {
            sendProxyError(response, 400, "The proxy request URL is invalid.");
            return;
        }
        if (target.protocol !== "http:") {
            sendProxyError(response, 501, "Use CONNECT for protocols other than plain HTTP.");
            return;
        }
        const connector = this.#connectorFor(request);
        if (connector === undefined) {
            sendProxyError(response, 502, "This proxy connection has no workspace network.");
            return;
        }
        const hostname = connectableHost(target.hostname);
        const port = target.port === "" ? 80 : Number(target.port);
        // The request's lifetime is the client's: once it gives up, so does everything opened
        // for it, whether or not the connection was established yet.
        let abandoned = false;
        let upstream: ReturnType<typeof requestHttp> | undefined;
        response.once("close", () => {
            if (response.writableFinished) return;
            abandoned = true;
            upstream?.destroy();
        });
        this.#open(connector, hostname, port, requestedHost(request.url!)).then(
            (connection) => {
                if (abandoned) {
                    connection.destroy();
                    return;
                }
                const outgoing = requestHttp(
                    {
                        hostname,
                        port,
                        path: `${target.pathname}${target.search}`,
                        method: request.method,
                        headers: endToEndHeaders(request.headers),
                        createConnection: () => connection as Socket,
                    },
                    (upstreamResponse) => {
                        response.writeHead(
                            upstreamResponse.statusCode ?? 502,
                            upstreamResponse.statusMessage,
                            endToEndHeaders(upstreamResponse.headers),
                        );
                        const settled = (): void => {
                            outgoing.destroy();
                        };
                        void streamToOutgoing(upstreamResponse, response).then(settled, settled);
                    },
                );
                upstream = outgoing;
                outgoing.on("error", () => {
                    if (!response.headersSent) {
                        sendProxyError(response, 502, "The proxied service could not be reached.");
                    } else {
                        response.destroy();
                    }
                });
                void streamToOutgoing(request, outgoing).catch(() => undefined);
            },
            (error: unknown) => {
                if (abandoned) return;
                if (error instanceof WorkspaceProxyPolicyError) {
                    sendProxyError(response, 403, error.message);
                } else if (error instanceof ConnectTimeoutError) {
                    sendProxyError(response, 504, "The proxied service took too long to answer.");
                } else {
                    sendProxyError(response, 502, "The proxied service could not be reached.");
                }
            },
        );
    }

    #openTunnel(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        let target: URL;
        try {
            target = new URL(`http://${request.url ?? ""}`);
        } catch {
            refuse(socket, 400, "Bad Request");
            return;
        }
        const port = target.port === "" ? 80 : Number(target.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535 || target.hostname.length === 0) {
            refuse(socket, 400, "Bad Request");
            return;
        }
        const connector = this.#connectorFor(request);
        if (connector === undefined) {
            refuse(socket, 502, "Bad Gateway");
            return;
        }
        // HTTP hands a CONNECT socket over without its error handling. A reset while the
        // connection is still being opened must only close this tunnel.
        socket.on("error", () => undefined);
        this.#open(
            connector,
            connectableHost(target.hostname),
            port,
            requestedHost(`http://${request.url!}`),
        ).then(
            (upstream) => {
                if (socket.destroyed) {
                    upstream.destroy();
                    return;
                }
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.byteLength > 0) upstream.write(head);
                joinTunnel(socket, upstream);
            },
            (error: unknown) => {
                if (error instanceof WorkspaceProxyPolicyError) refuse(socket, 403, "Forbidden");
                else if (error instanceof ConnectTimeoutError)
                    refuse(socket, 504, "Gateway Timeout");
                else refuse(socket, 502, "Bad Gateway");
            },
        );
    }
}

class ConnectTimeoutError extends Error {
    constructor() {
        super("Opening the connection took too long.");
    }
}

/**
 * Join both ends of an established tunnel. Each side's end of stream half-closes the other
 * direction. A side that is reset or closes before its end of stream ends the other at once; one
 * that closes after it ends the other once everything written to it has been delivered.
 */
function joinTunnel(client: Duplex, upstream: Duplex): void {
    client.pipe(upstream);
    upstream.pipe(client);
    const follow = (from: Duplex, to: Duplex): void => {
        from.on("error", () => abort(to));
        from.once("close", () => {
            if (!from.readableEnded) abort(to);
            else closeAfterFlush(to);
        });
    };
    follow(client, upstream);
    follow(upstream, client);
}

/** End a side abruptly: a TCP reset where the side is a socket, so the peer sees one too. */
function abort(stream: Duplex): void {
    if (stream.destroyed) return;
    const socket = stream as Partial<Socket>;
    if (typeof socket.resetAndDestroy === "function" && socket.connecting === false) {
        try {
            socket.resetAndDestroy();
            return;
        } catch {
            // Not a connected TCP socket after all; destroy it as any stream.
        }
    }
    stream.destroy();
}

function closeAfterFlush(stream: Duplex): void {
    if (stream.destroyed) return;
    if (stream.writableFinished) {
        stream.destroy();
        return;
    }
    stream.once("finish", () => stream.destroy());
    stream.end();
}

/** A URL's host as a connection names it: an IPv6 literal without its brackets. */
function connectableHost(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Preserve spelling for origin policy; URL parsing above still owns syntax and connection routing. */
function requestedHost(target: string): string {
    const authority = target.slice(target.indexOf("://") + 3).split(/[/?#\\]/, 1)[0]!;
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    return hostPort.startsWith("[")
        ? hostPort.slice(1, hostPort.indexOf("]"))
        : hostPort.split(":", 1)[0]!;
}

/** The headers a hop forwards: everything except what describes its own connection. */
function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    const named = new Set(
        String(headers.connection ?? "")
            .split(",")
            .map((name) => name.trim().toLowerCase())
            .filter((name) => name.length > 0),
    );
    const forwarded: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_HEADERS.has(name) || named.has(name)) continue;
        forwarded[name] = value;
    }
    return forwarded;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
}

function sendProxyError(response: ServerResponse, status: number, message: string): void {
    if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
    }
    const body = Buffer.from(message);
    response.writeHead(status, {
        connection: "close",
        "content-length": body.byteLength,
        "content-type": "text/plain; charset=utf-8",
    });
    response.end(body);
}

function refuse(socket: Duplex, status: number, statusText: string): void {
    if (socket.destroyed) return;
    socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}
