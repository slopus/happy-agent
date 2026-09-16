import { once } from "node:events";
import { createServer, request, Agent, type RequestListener } from "node:http";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ServiceHttpTunnel } from "../../sources/api/ServiceHttpTunnel.js";

async function fixture(handler: RequestListener) {
    const app = createServer(handler);
    const peers = new Set<Socket>();
    const tunnels = new Set<ServiceHttpTunnel>();
    const track = (socket: Socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.on("error", () => {});
        return socket;
    };
    app.on("connection", track);
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appPort = (app.address() as { port: number }).port;
    const gateway = createTcpServer((client) => {
        track(client);
        const endpoint = track(connect(appPort, "127.0.0.1"));
        endpoint.once("connect", () => {
            const tunnel = new ServiceHttpTunnel(endpoint, () => tunnels.delete(tunnel));
            tunnels.add(tunnel);
            tunnel.accept(client, Buffer.alloc(0));
        });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as { port: number }).port;
    const client = track(connect(port, "127.0.0.1"));
    expect((await once(client, "data"))[0].toString()).toBe(
        "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => client;
    return {
        app,
        client,
        agent,
        tunnels,
        async read(path: string, body?: string) {
            return await new Promise<{
                status: number;
                body: string;
                headers: import("node:http").IncomingHttpHeaders;
            }>((resolve, reject) => {
                const req = request(
                    {
                        host: "private.localhost",
                        agent,
                        path,
                        method: body === undefined ? "GET" : "POST",
                        headers: {
                            authorization: "Bearer application-only",
                            cookie: "session=application",
                            ...(body === undefined ? {} : { "transfer-encoding": "chunked" }),
                        },
                    },
                    (response) => {
                        const chunks: Buffer[] = [];
                        response.on("data", (chunk) => chunks.push(chunk));
                        response.on("error", reject);
                        response.once("end", () =>
                            resolve({
                                status: response.statusCode!,
                                body: Buffer.concat(chunks).toString(),
                                headers: response.headers,
                            }),
                        );
                    },
                );
                req.on("error", reject);
                req.end(body);
            });
        },
        async close() {
            agent.destroy();
            for (const tunnel of tunnels) tunnel.close();
            for (const peer of peers) peer.destroy();
            await Promise.all([
                new Promise<void>((resolve) => app.close(() => resolve())),
                new Promise<void>((resolve) => gateway.close(() => resolve())),
            ]);
        },
    };
}

describe("fixed workspace service HTTP attachment", () => {
    it("preserves parsed request framing when Connection nominates Content-Length", async () => {
        const received: { url: string; body: string }[] = [];
        const f = await fixture(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            received.push({ url: req.url!, body: Buffer.concat(chunks).toString() });
            res.end("received");
        });
        try {
            const response = once(f.client, "data");
            f.client.write(
                "GET /body HTTP/1.1\r\nHost: private.localhost\r\nConnection: content-length\r\nContent-Length: 5\r\n\r\nhello",
            );
            expect((await response)[0].toString()).toContain("200 OK");
            expect(received).toEqual([{ url: "/body", body: "hello" }]);
        } finally {
            await f.close();
        }
    });

    it("does not apply the header deadline to a quiet active SSE response", async () => {
        let response: import("node:http").ServerResponse | undefined;
        const f = await fixture((_req, res) => {
            response = res;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: first\n\n");
        });
        try {
            const result = f.read("/events");
            await new Promise<void>((resolve) => setTimeout(resolve, 10_100));
            expect(f.client.destroyed).toBe(false);
            response!.end("data: last\n\n");
            expect(await result).toMatchObject({ body: "data: first\n\ndata: last\n\n" });
        } finally {
            await f.close();
        }
    }, 15_000);

    it("streams a chunked upload and keeps application credentials, cookies and redirects", async () => {
        const received: string[] = [];
        const f = await fixture((req, res) => {
            expect(req.headers.authorization).toBe("Bearer application-only");
            expect(req.headers.cookie).toBe("session=application");
            expect(req.headers.host).toBe("private.localhost");
            received.push(req.url!);
            if (req.url === "/redirect") {
                res.writeHead(302, { location: "https://example.com/unchanged" });
                res.end();
                return;
            }
            res.setHeader("set-cookie", ["first=1", "second=2"]);
            req.pipe(res);
        });
        try {
            const body = "streamed-🦊".repeat(20000);
            const result = await f.read("/echo", body);
            expect(result).toMatchObject({
                status: 200,
                body,
                headers: { "set-cookie": ["first=1", "second=2"] },
            });
            expect(await f.read("/redirect")).toMatchObject({
                status: 302,
                headers: { location: "https://example.com/unchanged" },
            });
            expect(received).toEqual(["/echo", "/redirect"]);
        } finally {
            await f.close();
        }
    });

    it.each([
        "GET http://example.com/private HTTP/1.1\r\nHost: example.com\r\n\r\n",
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
        "GET / HTTP/1.0\r\n\r\n",
        "POST / HTTP/1.1\r\nHost: private.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        "GET / HTTP/1.1\r\nHost: private.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nContent-Length: 1\r\n\r\nx",
    ])("refuses destination selection or a non-origin protocol: %s", async (head) => {
        let calls = 0;
        const f = await fixture((_req, res) => {
            calls += 1;
            res.end("unexpected");
        });
        f.app.on("upgrade", (_request, socket) => {
            calls += 1;
            socket.end();
        });
        try {
            f.client.resume();
            const ended = once(f.client, "end");
            f.client.write(head);
            await ended;
            expect(calls).toBe(0);
        } finally {
            await f.close();
        }
    });

    it("forwards a WebSocket upgrade and binary messages over the same endpoint", async () => {
        const f = await fixture((_req, res) => res.end());
        const server = new WebSocketServer({ noServer: true });
        f.app.on("upgrade", (req, socket, head) =>
            server.handleUpgrade(req, socket, head, (peer) =>
                peer.on("message", (bytes) => peer.send(bytes)),
            ),
        );
        const websocket = new WebSocket("ws://private.localhost/socket", {
            createConnection: () => f.client,
        });
        try {
            await once(websocket, "open");
            const reply = once(websocket, "message");
            websocket.send(Buffer.from([0, 255, 1, 128]));
            expect((await reply)[0]).toEqual(Buffer.from([0, 255, 1, 128]));
        } finally {
            websocket.terminate();
            for (const peer of server.clients) peer.terminate();
            server.close();
            await f.close();
        }
    });
});
