import {
    Agent,
    request as httpRequest,
    type IncomingMessage,
    type ServerResponse,
    type OutgoingHttpHeaders,
} from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { healthResponseSchema, type HealthResponse } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { ConnectionHealth } from "../ConnectionHealth.js";

import { RemoteConnectionError } from "../RemoteConnectionError.js";
import { keepWebSocketAlive } from "./webSocketKeepalive.js";

/** The most body bytes read to screen a refusal or observe a relayed health response. */
const MAX_INSPECTED_BODY_BYTES = 64 * 1024;

const HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    // A person's token for a server connection by URL; forwarded only as `Authorization`.
    "happy-remote-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/** How far a forwarded exchange got, for timing diagnostics. */
export interface RemoteProxyExchange {
    /** The remote's status, once its response or upgrade began. */
    status?: number;
    /** `performance.now()` when the remote's response headers arrived. */
    respondedAt?: number;
    /** An event stream, upgrade, or tunnel, whose total duration is its open lifetime. */
    streaming: boolean;
}

/** Where the carrier's requests go on the remote: its `Host` and the path every request is under. */
export interface RemoteProxyTarget {
    readonly host: string;
    /** Prefixed to every remote path; empty, or a path such as `/team` without a trailing `/`. */
    readonly pathPrefix: string;
}

/** A remote answer to screen before it reaches the client. */
export interface RemoteProxyAnswer {
    readonly status: number;
    readonly contentType: string | undefined;
    /** The complete body of a `401` or `403`, or undefined for a redirect or an oversized body. */
    readonly body: Buffer | undefined;
}

/** A local answer that replaces the remote's. */
export interface RemoteProxyReplacement {
    readonly status: number;
    readonly body: Record<string, unknown>;
}

export interface RemoteProxyOptions {
    readonly target?: RemoteProxyTarget;
    /**
     * Screens every remote redirect, `401`, and `403`, given the token the request carried. A
     * replacement is answered instead, and the remote's answer is discarded.
     */
    readonly screen?: (
        answer: RemoteProxyAnswer,
        token: string,
    ) => Promise<RemoteProxyReplacement | undefined>;
    /**
     * An event stream silent this long ends. A WebSocket is pinged every third of it and closed
     * with 1011 once the remote has been silent this long.
     */
    readonly idleMs?: number;
    /** Receives every successful remote health response this pool relays. */
    readonly onHealth?: (health: HealthResponse) => void;
}

/**
 * One reusable HTTP pool. Every request and attachment gets its own carrier stream at once, so a
 * burst never waits behind another request or an open event stream. A failed exchange is never
 * retried by this layer.
 *
 * Upgrades and `CONNECT` tunnels always open a fresh carrier of their own. The remote front door
 * routes a connection by its first request, so a tunnel sent on a pooled connection that already
 * carried an ordinary request never reaches the tunnel's handler.
 */
export class RemoteProxyConnection {
    readonly #agent: Agent;
    readonly #attachments: Agent;
    readonly #active = new Set<AbortController>();
    #closed = false;

    readonly #closeTransport: (() => Promise<void>) | undefined;
    readonly #options: RemoteProxyOptions;
    constructor(
        connect: () => Duplex | Promise<Duplex>,
        closeTransport?: () => Promise<void>,
        options: RemoteProxyOptions = {},
    ) {
        this.#closeTransport = closeTransport;
        this.#options = options;
        this.#agent = new Agent({
            keepAlive: true,
            timeout: 30_000,
        });
        this.#attachments = new Agent({ keepAlive: false });
        const createConnection: Agent["createConnection"] = (_options, callback) => {
            void Promise.resolve()
                .then(connect)
                .then(
                    (socket) => {
                        if (this.#closed) {
                            socket.destroy();
                            callback?.(unavailable(), undefined as never);
                        } else callback?.(null, socket);
                    },
                    () => callback?.(unavailable(), undefined as never),
                );
            return undefined;
        };
        this.#agent.createConnection = createConnection;
        this.#attachments.createConnection = createConnection;
    }

    async close(): Promise<void> {
        this.#closed = true;
        for (const controller of this.#active) controller.abort(unavailable());
        this.#agent.destroy();
        this.#attachments.destroy();
        await this.#closeTransport?.();
    }

    /** An authenticated, bounded read over the same pool used by client proxy requests. */
    async health(
        authorize: (signal: AbortSignal) => Promise<string>,
    ): Promise<Omit<ConnectionHealth, "connectionId">> {
        if (this.#closed) throw unavailable();
        const controller = new AbortController();
        this.#active.add(controller);
        const timer = setTimeout(
            () =>
                controller.abort(
                    new RemoteConnectionError(
                        504,
                        "remote_timeout",
                        "The remote health check timed out.",
                    ),
                ),
            30_000,
        );
        timer.unref();
        try {
            const token = await abortable(authorize(controller.signal), controller.signal);
            controller.signal.throwIfAborted();
            return await new Promise((resolve, reject) => {
                const upstream = httpRequest({
                    agent: this.#agent,
                    hostname: "happy-agent.invalid",
                    path: `${this.#options.target?.pathPrefix ?? ""}/v0/health`,
                    headers: {
                        authorization: `Bearer ${token}`,
                        host: this.#options.target?.host ?? "happy-agent.invalid",
                    },
                });
                const cancel = () => {
                    upstream.destroy();
                    reject(controller.signal.reason);
                };
                controller.signal.addEventListener("abort", cancel, { once: true });
                upstream.once("error", () =>
                    reject(controller.signal.aborted ? controller.signal.reason : unavailable()),
                );
                upstream.once("close", () =>
                    controller.signal.removeEventListener("abort", cancel),
                );
                upstream.once("response", (response) => {
                    if (response.statusCode !== 200) {
                        response.destroy();
                        resolve({
                            reachable: true,
                            authenticated: false,
                            ready: false,
                            error:
                                response.statusCode === 401
                                    ? "The remote rejected authentication."
                                    : "The remote health endpoint returned an unsuccessful response.",
                        });
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > 64 * 1024) {
                            response.destroy();
                            reject(unavailable());
                        } else chunks.push(chunk);
                    });
                    response.once("error", () => reject(unavailable()));
                    response.once("aborted", () => reject(unavailable()));
                    response.once("end", () => {
                        try {
                            const value: unknown = JSON.parse(
                                Buffer.concat(chunks).toString("utf8"),
                            );
                            if (!Value.Check(healthResponseSchema, value)) throw unavailable();
                            resolve({
                                reachable: true,
                                authenticated: true,
                                ready: value.ready,
                                protocol: value.version.protocol,
                            });
                        } catch {
                            reject(unavailable());
                        }
                    });
                });
                upstream.end();
            });
        } finally {
            clearTimeout(timer);
            this.#active.delete(controller);
        }
    }

    async forward(
        request: IncomingMessage,
        destination: ServerResponse | Duplex,
        path: string,
        authorize: (signal: AbortSignal) => Promise<string>,
        head?: Buffer,
    ): Promise<RemoteProxyExchange> {
        if (this.#closed) throw unavailable();
        const controller = new AbortController();
        this.#active.add(controller);
        const signal = controller.signal;
        const exchange: RemoteProxyExchange = { streaming: head !== undefined };
        const abort = () => controller.abort(unavailable());
        const timer = setTimeout(
            () =>
                controller.abort(
                    new RemoteConnectionError(
                        504,
                        "remote_timeout",
                        "The remote connection timed out.",
                    ),
                ),
            30_000,
        );
        timer.unref();
        destination.once("close", abort);
        request.once("aborted", abort);
        if (destination.destroyed || (request.destroyed && !request.complete)) abort();
        let responseStarted = false;
        try {
            signal.throwIfAborted();
            const token = await abortable(authorize(signal), signal);
            signal.throwIfAborted();
            const upgraded = head !== undefined;
            const headers = proxyHeaders(request.headers);
            headers.authorization = `Bearer ${token}`;
            headers.host = this.#options.target?.host ?? "happy-agent.invalid";
            const idleMs = this.#options.idleMs;
            if (upgraded && request.method !== "CONNECT") {
                headers.connection = "upgrade";
                headers.upgrade = request.headers.upgrade ?? "websocket";
            }
            await new Promise<void>((resolve, reject) => {
                const upstream = httpRequest({
                    agent: upgraded ? this.#attachments : this.#agent,
                    hostname: "happy-agent.invalid",
                    method: request.method,
                    path: `${this.#options.target?.pathPrefix ?? ""}${path}`,
                    headers,
                });
                let finished = false;
                let remote: IncomingMessage | Duplex | undefined;
                const finish = (error?: unknown) => {
                    if (finished) return;
                    finished = true;
                    signal.removeEventListener("abort", cancel);
                    if (error !== undefined) {
                        upstream.destroy();
                        remote?.destroy();
                        reject(error);
                    } else resolve();
                };
                const cancel = () => finish(signal.reason);
                signal.addEventListener("abort", cancel, { once: true });
                upstream.once("error", () =>
                    finish(signal.aborted ? signal.reason : unavailable()),
                );
                const deliver = (response: IncomingMessage, body: Buffer | undefined) => {
                    const status = response.statusCode ?? 502;
                    responseStarted = true;
                    exchange.status = status;
                    exchange.respondedAt = performance.now();
                    const eventStream = (response.headers["content-type"] ?? "")
                        .toLowerCase()
                        .startsWith("text/event-stream");
                    exchange.streaming ||= eventStream;
                    if (eventStream && idleMs !== undefined) {
                        // A stream that sends nothing, not even a heartbeat, is dead; the client
                        // resumes from its cursor.
                        response.socket.setTimeout(idleMs, () => response.destroy());
                    }
                    if (
                        body === undefined &&
                        !upgraded &&
                        status === 200 &&
                        this.#options.onHealth !== undefined &&
                        /^\/v0\/health(?:\?|$)/u.test(path)
                    ) {
                        this.#observeHealth(response, this.#options.onHealth);
                    }
                    const responseHeaders = proxyHeaders(response.headers);
                    if (upgraded) {
                        const socket = destination as Duplex;
                        socket.write(responseHead(status, responseHeaders));
                        if (body === undefined) response.pipe(socket);
                        else socket.end(body);
                    } else {
                        const output = destination as ServerResponse;
                        // Drop the local API default even when the upstream supplies no policy.
                        output.removeHeader("cache-control");
                        output.writeHead(status, responseHeaders);
                        if (body === undefined) response.pipe(output);
                        else output.end(body);
                    }
                    if (body !== undefined) {
                        finish();
                        return;
                    }
                    response.once("error", () => finish(unavailable()));
                    response.once("aborted", () => finish(unavailable()));
                    response.once("end", () => finish());
                };
                const replace = (replacement: RemoteProxyReplacement) => {
                    responseStarted = true;
                    exchange.status = replacement.status;
                    exchange.respondedAt = performance.now();
                    const body = Buffer.from(JSON.stringify(replacement.body));
                    const headers = {
                        "cache-control": "no-store",
                        "content-length": String(body.length),
                        "content-type": "application/json; charset=utf-8",
                    };
                    if (upgraded) {
                        (destination as Duplex).end(
                            Buffer.concat([
                                Buffer.from(responseHead(replacement.status, headers)),
                                body,
                            ]),
                        );
                    } else {
                        const output = destination as ServerResponse;
                        output.writeHead(replacement.status, headers);
                        output.end(body);
                    }
                    finish();
                };
                upstream.once("response", (response) => {
                    clearTimeout(timer);
                    response.socket.setTimeout(0);
                    remote = response;
                    const screen = this.#options.screen;
                    const status = response.statusCode ?? 502;
                    if (screen === undefined || !screened(status)) {
                        deliver(response, undefined);
                        return;
                    }
                    void (async () => {
                        const body =
                            status === 401 || status === 403
                                ? await readBounded(response)
                                : undefined;
                        if (body === undefined) response.destroy();
                        const replacement = await screen(
                            {
                                status,
                                contentType: response.headers["content-type"],
                                body,
                            },
                            token,
                        );
                        if (finished) return;
                        if (replacement !== undefined) replace(replacement);
                        else deliver(response, body ?? Buffer.alloc(0));
                    })().catch((error: unknown) => finish(error));
                });
                const attach = (response: IncomingMessage, socket: Socket, remoteHead: Buffer) => {
                    clearTimeout(timer);
                    socket.setTimeout(0);
                    remote = socket;
                    if (!upgraded) {
                        socket.destroy();
                        finish(unavailable());
                        return;
                    }
                    const output = destination as Duplex;
                    responseStarted = true;
                    exchange.status = response.statusCode ?? 502;
                    exchange.respondedAt = performance.now();
                    const responseHeaders = proxyHeaders(response.headers);
                    if (response.statusCode === 101) {
                        responseHeaders.connection = "Upgrade";
                        responseHeaders.upgrade = response.headers.upgrade ?? "websocket";
                    }
                    output.write(responseHead(response.statusCode ?? 502, responseHeaders));
                    if (remoteHead.length > 0) output.write(remoteHead);
                    if (head !== undefined && head.length > 0) socket.write(head);
                    socket.on("error", () => finish(unavailable()));
                    output.on("error", () => finish(unavailable()));
                    const keepalive =
                        idleMs !== undefined &&
                        response.statusCode === 101 &&
                        request.method !== "CONNECT"
                            ? keepWebSocketAlive(output, socket, idleMs)
                            : undefined;
                    socket.once("close", () => {
                        keepalive?.dispose();
                        output.destroy();
                        finish();
                    });
                    socket.pipe(output);
                    if (keepalive === undefined) output.pipe(socket);
                    else output.pipe(keepalive.toRemote).pipe(socket);
                };
                upstream.once("upgrade", attach);
                upstream.once("connect", attach);
                if (upgraded) upstream.end();
                else request.pipe(upstream);
            });
        } catch (error) {
            if (responseStarted) destination.destroy();
            else throw error;
        } finally {
            clearTimeout(timer);
            destination.removeListener("close", abort);
            request.removeListener("aborted", abort);
            this.#active.delete(controller);
        }
        return exchange;
    }

    /** Read a relayed health body alongside the client, within the inspection bound. */
    #observeHealth(response: IncomingMessage, onHealth: (health: HealthResponse) => void): void {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_INSPECTED_BODY_BYTES) chunks.push(chunk);
        });
        response.once("end", () => {
            if (size > MAX_INSPECTED_BODY_BYTES) return;
            try {
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (Value.Check(healthResponseSchema, value)) onHealth(value);
            } catch {
                // The client still received the body exactly as the remote sent it.
            }
        });
    }
}

/** Redirects other than `304`, `401`, and `403` are screened. */
function screened(status: number): boolean {
    return (status >= 300 && status < 400 && status !== 304) || status === 401 || status === 403;
}

/** The whole body, or undefined once it passes the inspection bound. */
async function readBounded(response: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_INSPECTED_BODY_BYTES) return undefined;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function proxyHeaders(source: IncomingMessage["headers"]): OutgoingHttpHeaders {
    const blocked = new Set([
        ...HOP_HEADERS,
        ...(source.connection ?? "")
            .toLowerCase()
            .split(",")
            .map((value) => value.trim()),
    ]);
    return Object.fromEntries(
        Object.entries(source).filter(([name]) => !blocked.has(name.toLowerCase())),
    );
}

function responseHead(status: number, headers: OutgoingHttpHeaders): string {
    const lines = [
        `HTTP/1.1 ${status} ${status === 101 ? "Switching Protocols" : status === 200 ? "Connection Established" : "Remote Response"}`,
    ];
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    return `${lines.join("\r\n")}\r\n\r\n`;
}

function unavailable(): RemoteConnectionError {
    return new RemoteConnectionError(
        503,
        "remote_unavailable",
        "The remote Happy Agent is unavailable.",
    );
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let cancel: (() => void) | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                cancel = () => reject(signal.reason);
                signal.addEventListener("abort", cancel, { once: true });
            }),
        ]);
    } finally {
        if (cancel !== undefined) signal.removeEventListener("abort", cancel);
    }
}
