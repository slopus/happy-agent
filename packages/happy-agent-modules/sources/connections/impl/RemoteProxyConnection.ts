import {
    Agent,
    request as httpRequest,
    type IncomingMessage,
    type ServerResponse,
    type OutgoingHttpHeaders,
} from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { healthResponseSchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { ConnectionHealth } from "../ConnectionHealth.js";

import { RemoteConnectionError } from "../RemoteConnectionError.js";

const HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/** One bounded reusable HTTP pool. A failed exchange is never retried by this layer. */
export class RemoteProxyConnection {
    readonly #agent: Agent;
    readonly #active = new Set<AbortController>();
    #closed = false;

    readonly #closeTransport: (() => Promise<void>) | undefined;
    constructor(connect: () => Duplex | Promise<Duplex>, closeTransport?: () => Promise<void>) {
        this.#closeTransport = closeTransport;
        this.#agent = new Agent({
            keepAlive: true,
            maxSockets: 32,
            maxFreeSockets: 4,
            timeout: 30_000,
        });
        this.#agent.createConnection = (_options, callback) => {
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
    }

    async close(): Promise<void> {
        this.#closed = true;
        for (const controller of this.#active) controller.abort(unavailable());
        this.#agent.destroy();
        await this.#closeTransport?.();
    }

    /** An authenticated, bounded read over the same pool used by client proxy requests. */
    async health(
        authorize: (signal: AbortSignal) => Promise<string>,
    ): Promise<Omit<ConnectionHealth, "connectionId">> {
        if (this.#closed) throw unavailable();
        if (this.#active.size >= 32)
            throw new RemoteConnectionError(503, "remote_busy", "The remote connection is busy.");
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
                    path: "/v0/health",
                    headers: { authorization: `Bearer ${token}` },
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
    ): Promise<void> {
        if (this.#closed) throw unavailable();
        if (this.#active.size >= 32)
            throw new RemoteConnectionError(503, "remote_busy", "The remote connection is busy.");
        const controller = new AbortController();
        this.#active.add(controller);
        const signal = controller.signal;
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
            headers.host = "happy-agent.invalid";
            if (upgraded && request.method !== "CONNECT") {
                headers.connection = "upgrade";
                headers.upgrade = request.headers.upgrade ?? "websocket";
            }
            await new Promise<void>((resolve, reject) => {
                const upstream = httpRequest({
                    agent: this.#agent,
                    hostname: "happy-agent.invalid",
                    method: request.method,
                    path,
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
                upstream.once("response", (response) => {
                    clearTimeout(timer);
                    response.socket.setTimeout(0);
                    responseStarted = true;
                    remote = response;
                    const responseHeaders = proxyHeaders(response.headers);
                    responseHeaders["cache-control"] = "no-store";
                    if (upgraded) {
                        const socket = destination as Duplex;
                        socket.write(responseHead(response.statusCode ?? 502, responseHeaders));
                        response.pipe(socket);
                    } else {
                        const output = destination as ServerResponse;
                        output.writeHead(response.statusCode ?? 502, responseHeaders);
                        response.pipe(output);
                    }
                    response.once("error", () => finish(unavailable()));
                    response.once("aborted", () => finish(unavailable()));
                    response.once("end", () => finish());
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
                    socket.once("close", () => {
                        output.destroy();
                        finish();
                    });
                    socket.pipe(output);
                    output.pipe(socket);
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
    }
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
