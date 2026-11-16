import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { LOCAL_TOKEN } from "./accountLinkWorld.js";

export interface SeenRequest {
    readonly headers: IncomingHttpHeaders;
    readonly method: string;
    readonly url: string;
}

/**
 * A stand-in for the standalone daemon's API on its Unix socket. Like the real one it serves
 * only the local owner token, so a test that reaches a route proves the token was swapped in.
 */
export class FakeLocalApi {
    readonly requests: SeenRequest[] = [];
    readonly sockets: WebSocket[] = [];
    /** Connections the peer closed before the response finished. */
    aborted = 0;
    #server!: Server;

    static async start(socketPath: string): Promise<FakeLocalApi> {
        const api = new FakeLocalApi();
        const sockets = new WebSocketServer({
            handleProtocols: (protocols) => (protocols.has("happy.v1") ? "happy.v1" : false),
            noServer: true,
        });
        api.#server = createServer((request, response) => {
            api.requests.push({
                headers: request.headers,
                method: request.method ?? "",
                url: request.url ?? "",
            });
            response.on("close", () => {
                if (!response.writableFinished) api.aborted += 1;
            });
            if (request.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end('{"code":"unauthorized"}');
                return;
            }
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname === "/v0/health") {
                const body = JSON.stringify({ ok: true, query: url.search });
                response.writeHead(200, {
                    "content-length": Buffer.byteLength(body),
                    "content-type": "application/json",
                    "set-cookie": ["a=1", "b=2"],
                });
                response.end(body);
            } else if (url.pathname === "/v0/echo") {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    response.writeHead(200, { "content-type": "application/octet-stream" });
                    response.end(Buffer.concat(chunks));
                });
            } else if (url.pathname === "/v0/events") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write("data: first\n\n");
                const timer = setInterval(() => response.write("data: tick\n\n"), 50);
                response.on("close", () => clearInterval(timer));
            } else if (url.pathname === "/v0/empty") {
                response.writeHead(204);
                response.end();
            } else {
                response.writeHead(404, { "content-type": "application/json" });
                response.end('{"code":"not_found"}');
            }
        });
        api.#server.on("upgrade", (request, socket, head) => {
            api.requests.push({
                headers: request.headers,
                method: request.method ?? "",
                url: request.url ?? "",
            });
            if (
                request.headers.authorization !== `Bearer ${LOCAL_TOKEN}` ||
                !request.url?.startsWith("/v0/stream")
            ) {
                socket.end(
                    "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
                return;
            }
            sockets.handleUpgrade(request, socket, head, (webSocket) => {
                api.sockets.push(webSocket);
                webSocket.on("message", (data, isBinary) => {
                    if (!isBinary && data.toString() === "flood") {
                        const megabyte = Buffer.alloc(1_048_576, 7);
                        for (let index = 0; index < 32; index += 1) webSocket.send(megabyte);
                        return;
                    }
                    webSocket.send(data, { binary: isBinary });
                });
            });
        });
        await new Promise<void>((resolve) => api.#server.listen(socketPath, resolve));
        return api;
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) socket.terminate();
        this.#server.closeAllConnections();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
}
