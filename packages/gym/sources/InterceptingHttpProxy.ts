import { createServer, request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface InterceptedHttpMessage {
    body: Uint8Array;
    headers: Readonly<Record<string, string | readonly string[]>>;
}

export interface InterceptedHttpRequest extends InterceptedHttpMessage {
    method: string;
    url: string;
}

export interface InterceptedHttpResponse extends InterceptedHttpMessage {
    status: number;
}

export interface HttpRequestReplacement {
    body?: string | Uint8Array;
    headers?: Readonly<Record<string, string | readonly string[]>>;
    method?: string;
    url?: string;
}

export interface HttpResponseReplacement {
    body?: string | Uint8Array;
    headers?: Readonly<Record<string, string | readonly string[]>>;
    status?: number;
}

export interface HttpInterceptAction {
    request?: HttpRequestReplacement;
    response?: HttpResponseReplacement;
    transformResponse?: HttpResponseTransformer;
}

export type HttpResponseTransformer = (
    response: InterceptedHttpResponse,
) => HttpResponseReplacement | undefined | Promise<HttpResponseReplacement | undefined>;

export type HttpInterceptHandler = (
    request: InterceptedHttpRequest,
    requestIndex: number,
) => HttpInterceptAction | undefined | Promise<HttpInterceptAction | undefined>;

export interface InterceptedHttpExchange {
    forwardedRequest?: InterceptedHttpRequest;
    request: InterceptedHttpRequest;
    response?: InterceptedHttpResponse;
    responseSource?: "interceptor" | "proxy" | "upstream";
}

export class InterceptingHttpProxy {
    readonly exchanges: InterceptedHttpExchange[] = [];

    #listenHost: "127.0.0.1" | "0.0.0.0";
    #handler: HttpInterceptHandler | undefined;
    #server: ReturnType<typeof createServer> | undefined;
    #sockets = new Set<Socket>();
    #url: string | undefined;

    constructor(handler?: HttpInterceptHandler, listenHost: "127.0.0.1" | "0.0.0.0" = "127.0.0.1") {
        this.#listenHost = listenHost;
        this.#handler = handler;
    }

    get url(): string {
        if (this.#url === undefined) throw new Error("Intercepting HTTP proxy has not started.");
        return this.#url;
    }

    get localUrl(): string {
        if (this.#url === undefined) throw new Error("Intercepting HTTP proxy has not started.");
        return this.#url.replace("host.docker.internal", "127.0.0.1");
    }

    async start(): Promise<void> {
        if (this.#server !== undefined) return;
        const server = createServer((request, response) => {
            void this.#handleHttp(request, response);
        });
        server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => this.#sockets.delete(socket));
        });
        server.on("connect", (request, socket, head) => {
            void this.#handleConnect(request, socket, head);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, this.#listenHost, () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Intercepting HTTP proxy did not receive a TCP port.");
        }
        this.#server = server;
        this.#url = `http://host.docker.internal:${address.port}`;
    }

    async stop(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        this.#url = undefined;
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        if (server === undefined) return;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
    }

    async #handleHttp(
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
    ): Promise<void> {
        const requestIndex = this.exchanges.length;
        const exchange: InterceptedHttpExchange = {
            request: {
                body: new Uint8Array(),
                headers: normalizeHeaders(request.headers),
                method: request.method ?? "GET",
                url: request.url ?? "/",
            },
        };
        this.exchanges.push(exchange);

        try {
            exchange.request = {
                ...exchange.request,
                body: await readBody(request),
                url: absoluteRequestUrl(request),
            };
            const action = await this.#handler?.(exchange.request, requestIndex);
            if (action?.response !== undefined) {
                const interceptedResponse = normalizeResponse(action.response);
                exchange.response = interceptedResponse;
                exchange.responseSource = "interceptor";
                sendResponse(response, interceptedResponse);
                return;
            }

            const forwardedRequest = applyRequestReplacement(exchange.request, action?.request);
            exchange.forwardedRequest = forwardedRequest;
            const upstreamResponse = await forwardRequest(forwardedRequest);
            const replacement = await action?.transformResponse?.(upstreamResponse);
            const finalResponse =
                replacement === undefined ? upstreamResponse : normalizeResponse(replacement);
            exchange.response = finalResponse;
            exchange.responseSource = replacement === undefined ? "upstream" : "interceptor";
            sendResponse(response, finalResponse);
        } catch (error) {
            const proxyResponse = normalizeResponse({
                body: error instanceof Error ? error.message : String(error),
                headers: { "content-type": "text/plain; charset=utf-8" },
                status: 502,
            });
            exchange.response = proxyResponse;
            exchange.responseSource = "proxy";
            sendResponse(response, proxyResponse);
        }
    }

    async #handleConnect(
        request: import("node:http").IncomingMessage,
        clientSocket: Duplex,
        head: Buffer,
    ): Promise<void> {
        let upstreamSocket: Socket | undefined;
        const closeUpstream = (): void => {
            upstreamSocket?.destroy();
        };
        clientSocket.on("error", closeUpstream);
        clientSocket.once("close", closeUpstream);
        const requestIndex = this.exchanges.length;
        const exchange: InterceptedHttpExchange = {
            request: {
                body: new Uint8Array(),
                headers: normalizeHeaders(request.headers),
                method: "CONNECT",
                url: request.url ?? "",
            },
        };
        this.exchanges.push(exchange);

        try {
            const action = await this.#handler?.(exchange.request, requestIndex);
            if (action?.response !== undefined) {
                const interceptedResponse = normalizeResponse(action.response);
                exchange.response = interceptedResponse;
                exchange.responseSource = "interceptor";
                // Retain the handler's result even when its client disconnected while awaiting it.
                if (!clientSocket.destroyed)
                    writeConnectResponse(clientSocket, interceptedResponse);
                return;
            }
            if (clientSocket.destroyed) return;

            const forwardedRequest = applyRequestReplacement(exchange.request, action?.request);
            exchange.forwardedRequest = forwardedRequest;
            const target = connectTarget(forwardedRequest.url);
            const connectedSocket = connect(target.port, target.hostname);
            upstreamSocket = connectedSocket;
            this.#sockets.add(connectedSocket);
            connectedSocket.once("connect", () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) connectedSocket.write(head);
                connectedSocket.pipe(clientSocket);
                clientSocket.pipe(connectedSocket);
                exchange.response = normalizeResponse({ status: 200 });
                exchange.responseSource = "upstream";
            });
            connectedSocket.once("close", () => this.#sockets.delete(connectedSocket));
            connectedSocket.once("error", (error) => {
                this.#sockets.delete(connectedSocket);
                if (!clientSocket.destroyed && exchange.response === undefined) {
                    const proxyResponse = normalizeResponse({
                        status: 502,
                        body: error.message,
                    });
                    exchange.response = proxyResponse;
                    exchange.responseSource = "proxy";
                    writeConnectResponse(clientSocket, proxyResponse);
                }
            });
        } catch (error) {
            const proxyResponse = normalizeResponse({
                body: error instanceof Error ? error.message : String(error),
                status: 502,
            });
            exchange.response = proxyResponse;
            exchange.responseSource = "proxy";
            writeConnectResponse(clientSocket, proxyResponse);
        }
    }
}

function absoluteRequestUrl(request: import("node:http").IncomingMessage): string {
    const requestUrl = request.url ?? "/";
    if (/^https?:\/\//u.test(requestUrl)) return requestUrl;
    const host = request.headers.host;
    if (host === undefined) throw new Error("Proxied HTTP request has no Host header.");
    return `http://${host}${requestUrl}`;
}

function applyRequestReplacement(
    request: InterceptedHttpRequest,
    replacement: HttpRequestReplacement | undefined,
): InterceptedHttpRequest {
    if (replacement === undefined) return request;
    return {
        body: replacement.body === undefined ? request.body : toBytes(replacement.body),
        headers: replacement.headers === undefined ? request.headers : replacement.headers,
        method: replacement.method ?? request.method,
        url: replacement.url ?? request.url,
    };
}

function connectTarget(authority: string): { hostname: string; port: number } {
    const target = new URL(`http://${authority}`);
    return {
        hostname: target.hostname,
        port: target.port.length === 0 ? 443 : Number(target.port),
    };
}

async function forwardRequest(request: InterceptedHttpRequest): Promise<InterceptedHttpResponse> {
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error(`Unsupported proxy target protocol '${target.protocol}'.`);
    }
    const headers = mutableHeaders(request.headers);
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    headers.host = target.host;
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["content-length"] = String(request.body.byteLength);

    return new Promise((resolve, reject) => {
        const upstreamRequest = (target.protocol === "https:" ? requestHttps : requestHttp)(
            target,
            { headers, method: request.method },
            async (upstreamResponse) => {
                try {
                    resolve({
                        body: await readBody(upstreamResponse),
                        headers: normalizeHeaders(upstreamResponse.headers),
                        status: upstreamResponse.statusCode ?? 502,
                    });
                } catch (error) {
                    reject(error);
                }
            },
        );
        upstreamRequest.once("error", reject);
        upstreamRequest.end(request.body);
    });
}

function mutableHeaders(
    headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> {
    return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
            name,
            typeof value === "string" ? value : [...value],
        ]),
    );
}

function normalizeHeaders(
    headers: IncomingHttpHeaders,
): Readonly<Record<string, string | readonly string[]>> {
    return Object.fromEntries(
        Object.entries(headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]],
        ),
    );
}

function normalizeResponse(response: HttpResponseReplacement): InterceptedHttpResponse {
    return {
        body: toBytes(response.body ?? ""),
        headers: response.headers ?? {},
        status: response.status ?? 200,
    };
}

async function readBody(stream: AsyncIterable<unknown>): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        length += buffer.length;
        if (length > 32 * 1024 * 1024) throw new Error("Proxied HTTP message is too large.");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function sendResponse(
    response: import("node:http").ServerResponse,
    intercepted: InterceptedHttpResponse,
): void {
    const headers = mutableHeaders(intercepted.headers);
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["content-length"] = String(intercepted.body.byteLength);
    response.writeHead(intercepted.status, headers);
    response.end(intercepted.body);
}

function statusText(status: number): string {
    if (status === 200) return "Connection Established";
    if (status === 502) return "Bad Gateway";
    return "Proxy Response";
}

function toBytes(body: string | Uint8Array): Uint8Array {
    return typeof body === "string" ? Buffer.from(body) : body;
}

function writeConnectResponse(socket: Duplex, response: InterceptedHttpResponse): void {
    const headers = mutableHeaders(response.headers);
    headers["content-length"] = String(response.body.byteLength);
    socket.end(
        Buffer.concat([
            Buffer.from(
                `HTTP/1.1 ${response.status} ${statusText(response.status)}\r\n${Object.entries(
                    headers,
                )
                    .map(
                        ([name, value]) =>
                            `${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
                    )
                    .join("\r\n")}\r\n\r\n`,
            ),
            Buffer.from(response.body),
        ]),
    );
}
