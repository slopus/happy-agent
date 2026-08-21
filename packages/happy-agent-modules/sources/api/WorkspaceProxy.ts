import { chmod, unlink } from "node:fs/promises";
import {
    createServer,
    request as requestHttp,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * HTTP/1.1 forward proxy spoken inside the workspace CONNECT attachment.
 *
 * Current project and workspace computes are host folders, so their network context is the daemon
 * host. The proxy still lives behind one workspace-authenticated outer tunnel, leaving the
 * transport unchanged when a non-host compute later supplies the equivalent connection seam.
 */
export class WorkspaceProxy {
    readonly #server = createServer();
    readonly #sockets = new Set<Duplex>();
    #socketPath: string | undefined;

    constructor() {
        this.#server.on("request", (request, response) => {
            this.#forwardRequest(request, response);
        });
        this.#server.on("connect", (request, socket, head) => {
            this.#openTunnel(request, socket, head);
        });
        this.#server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => {
                this.#sockets.delete(socket);
            });
        });
        this.#server.on("clientError", (_error, socket) => {
            refuse(socket, 400, "Bad Request");
        });
    }

    accept(socket: Socket, head: Buffer): void {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
            if (head.byteLength > 0) socket.unshift(head);
            this.#server.emit("connection", socket);
            socket.resume();
        });
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

    async close(): Promise<void> {
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        const path = this.#socketPath;
        this.#socketPath = undefined;
        if (path === undefined) return;
        await new Promise<void>((resolve, reject) => {
            this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
        }).catch((error: unknown) => {
            if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
        });
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
        const headers = { ...request.headers };
        delete headers["proxy-connection"];
        const upstream = requestHttp(
            {
                hostname: target.hostname,
                port: target.port === "" ? 80 : Number(target.port),
                path: `${target.pathname}${target.search}`,
                method: request.method,
                headers,
                signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
            },
            (upstreamResponse) => {
                response.writeHead(
                    upstreamResponse.statusCode ?? 502,
                    upstreamResponse.statusMessage,
                    upstreamResponse.headers,
                );
                upstreamResponse.pipe(response);
            },
        );
        upstream.on("error", () => {
            if (!response.headersSent) {
                sendProxyError(response, 502, "The proxied service could not be reached.");
            } else {
                response.destroy();
            }
        });
        request.pipe(upstream);
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
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
            refuse(socket, 400, "Bad Request");
            return;
        }
        const upstream = connectTcp({
            host: target.hostname,
            port,
        });
        const timeout = setTimeout(() => {
            upstream.destroy();
            refuse(socket, 504, "Gateway Timeout");
        }, CONNECT_TIMEOUT_MS);
        timeout.unref();
        upstream.once("connect", () => {
            clearTimeout(timeout);
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.byteLength > 0) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.once("error", () => {
            clearTimeout(timeout);
            refuse(socket, 502, "Bad Gateway");
        });
        socket.once("close", () => upstream.destroy());
    }
}

function sendProxyError(response: ServerResponse, status: number, message: string): void {
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
