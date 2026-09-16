import {
    Agent,
    createServer,
    request as requestHttp,
    type ClientRequest,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const originRequestSchema = Type.Object(
    {
        url: Type.String({ maxLength: 65536, pattern: "^/(?!/)[^\\u0000-\\u0020\\u007F#]*$" }),
        httpVersion: Type.Literal("1.1"),
    },
    { additionalProperties: true },
);
const websocketRequestSchema = Type.Object(
    {
        method: Type.Literal("GET"),
        headers: Type.Object(
            {
                "sec-websocket-version": Type.Literal("13"),
                "sec-websocket-key": Type.String({ pattern: "^[A-Za-z0-9+/]{22}==$" }),
                "content-length": Type.Optional(Type.Literal("0")),
                "transfer-encoding": Type.Optional(Type.Never()),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);
const HEADER_TIMEOUT_MS = 10_000;
const MAX_PIPELINED_REQUESTS = 8;
const MAX_HEADER_BYTES = 64 * 1024;

/** One authenticated attachment, one already-connected supervisor endpoint, no listener or dialer. */
export class ServiceHttpTunnel {
    readonly #http = createServer({
        maxHeaderSize: MAX_HEADER_BYTES,
        requestTimeout: 0,
        headersTimeout: 0,
    });
    readonly #agent = new Agent({
        keepAlive: true,
        maxSockets: 1,
        maxTotalSockets: 1,
        maxFreeSockets: 1,
    });
    readonly #requests = new Set<ClientRequest>();
    #client: Duplex | undefined;
    #timer: NodeJS.Timeout | undefined;
    #inFlight = 0;
    #upgraded = false;
    #closed = false;

    constructor(
        readonly endpoint: Socket,
        readonly onClose: () => void,
    ) {
        let used = false;
        // Never reconnect or replay, including when the application closes its keep-alive socket.
        this.#agent.createConnection = () => {
            if (used || endpoint.destroyed) throw new Error("The service connection has closed.");
            used = true;
            return endpoint;
        };
        endpoint.on("error", () => this.close());
        endpoint.on("close", () => {
            if (this.#inFlight === 0 || this.#upgraded) this.close();
        });
        this.#http.on("request", (request, response) => this.#request(request, response));
        this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
        this.#http.on("connect", (_request, socket) => {
            refuse(socket);
            this.#armHeaderTimeout();
        });
        this.#http.on("clientError", (_error, socket) => {
            refuse(socket);
            this.#armHeaderTimeout();
        });
    }

    accept(client: Duplex, head: Buffer): void {
        if (this.#client !== undefined || this.#closed || head.length > MAX_HEADER_BYTES) {
            client.destroy();
            this.close();
            return;
        }
        this.#client = client;
        client.once("close", () => this.close());
        client.on("error", () => this.close());
        this.#armHeaderTimeout();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
            if (this.#closed) return;
            if (head.length > 0) client.unshift(head);
            this.#http.emit("connection", client);
            client.resume();
        });
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        for (const request of this.#requests) request.destroy();
        this.#requests.clear();
        this.#agent.destroy();
        this.endpoint.destroy();
        this.#client?.destroy();
        this.onClose();
    }

    #admit(request: IncomingMessage): boolean {
        if (this.#closed || this.#upgraded || !Value.Check(originRequestSchema, request))
            return false;
        if (this.#inFlight >= MAX_PIPELINED_REQUESTS) return false;
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#inFlight += 1;
        return true;
    }

    #request(request: IncomingMessage, response: ServerResponse): void {
        if (!this.#admit(request)) {
            this.close();
            return;
        }
        let finished = false;
        response.once("finish", () => {
            finished = true;
            this.#inFlight -= 1;
            if (this.#inFlight !== 0) return;
            if (this.endpoint.destroyed) this.#client?.end();
            this.#armHeaderTimeout();
        });
        response.once("close", () => {
            if (!finished) this.close();
        });
        request.once("aborted", () => this.close());
        try {
            const upstream = this.#forward(request, (incoming) => {
                incoming.once("aborted", () => this.close());
                incoming.on("error", () => this.close());
                response.writeHead(
                    incoming.statusCode ?? 502,
                    incoming.statusMessage,
                    forwardHeaders(incoming),
                );
                incoming.once("end", () => response.addTrailers(incoming.trailers));
                incoming.pipe(response);
            });
            // An unsolicited upgrade is never a raw transport escape.
            upstream.once("upgrade", (_incoming, socket) => {
                socket.destroy();
                this.close();
            });
            request.once("end", () => upstream.addTrailers(request.trailers));
            request.pipe(upstream);
        } catch {
            this.close();
        }
    }

    #upgrade(request: IncomingMessage, client: Duplex, head: Buffer): void {
        if (
            this.#inFlight !== 0 ||
            request.headers.upgrade?.toLowerCase() !== "websocket" ||
            !Value.Check(websocketRequestSchema, request) ||
            head.length > MAX_HEADER_BYTES ||
            !this.#admit(request)
        ) {
            this.close();
            return;
        }
        try {
            const upstream = this.#forward(
                request,
                (incoming) => {
                    // Rejected handshakes carry a decoded body delimited by closing this attachment.
                    client.write(responseHead(incoming));
                    incoming.on("error", () => this.close());
                    incoming.once("aborted", () => this.close());
                    incoming.pipe(client);
                    incoming.once("end", () => this.#armHeaderTimeout());
                },
                true,
            );
            upstream.once("upgrade", (incoming, socket, upstreamHead) => {
                if (
                    this.#closed ||
                    incoming.statusCode !== 101 ||
                    incoming.headers.upgrade?.toLowerCase() !== "websocket"
                ) {
                    socket.destroy();
                    this.close();
                    return;
                }
                this.#upgraded = true;
                client.write(responseHead(incoming));
                if (upstreamHead.length > 0) client.write(upstreamHead);
                if (head.length > 0) socket.write(head);
                socket.on("error", () => this.close());
                socket.once("close", () => this.close());
                client.pipe(socket);
                socket.pipe(client);
            });
            upstream.end();
        } catch {
            this.close();
        }
    }

    #forward(
        request: IncomingMessage,
        response: (incoming: IncomingMessage) => void,
        upgrade = false,
    ): ClientRequest {
        const headers = forwardHeaders(request, upgrade, true);
        // Frame the parsed body ourselves, independent of Connection's nominated fields.
        // Losing Content-Length here would turn a GET body into another upstream request.
        if (request.headers["transfer-encoding"] !== undefined)
            headers.push("Transfer-Encoding", "chunked");
        else if (request.headers["content-length"] !== undefined)
            headers.push("Content-Length", request.headers["content-length"]);
        const upstream = requestHttp(
            {
                // Never resolved: the one fixed socket above is the only transport.
                hostname: "workspace-service.invalid",
                port: 80,
                agent: this.#agent,
                method: request.method,
                path: request.url,
                headers,
                maxHeaderSize: MAX_HEADER_BYTES,
            },
            response,
        );
        this.#requests.add(upstream);
        upstream.once("close", () => this.#requests.delete(upstream));
        upstream.on("error", () => this.close());
        return upstream;
    }

    #armHeaderTimeout(): void {
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.close(), HEADER_TIMEOUT_MS);
        this.#timer.unref();
    }
}

/** Preserve application credentials and duplicate headers; discard HTTP hop-by-hop fields. */
function forwardHeaders(message: IncomingMessage, upgrade = false, request = false): string[] {
    const omitted = new Set([
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "transfer-encoding",
        "upgrade",
    ]);
    if (request) omitted.add("content-length");
    for (const name of (message.headers.connection ?? "").split(","))
        omitted.add(name.trim().toLowerCase());
    const headers: string[] = [];
    for (let index = 0; index < message.rawHeaders.length; index += 2) {
        const name = message.rawHeaders[index]!;
        if (!omitted.has(name.toLowerCase())) headers.push(name, message.rawHeaders[index + 1]!);
    }
    if (upgrade) headers.push("Connection", "Upgrade", "Upgrade", "websocket");
    return headers;
}

function responseHead(response: IncomingMessage): string {
    const headers = forwardHeaders(response, response.statusCode === 101);
    if (response.statusCode !== 101) headers.push("Connection", "close");
    let head = `HTTP/1.1 ${String(response.statusCode ?? 502)} ${response.statusMessage ?? ""}\r\n`;
    for (let index = 0; index < headers.length; index += 2)
        head += `${headers[index]}: ${headers[index + 1]}\r\n`;
    return `${head}\r\n`;
}

function refuse(socket: Duplex): void {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
