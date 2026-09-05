import {
    createServer,
    request,
    type IncomingMessage,
    type ServerResponse,
    type Server,
} from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteProxyConnection } from "../../sources/connections/impl/RemoteProxyConnection.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<number> {
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    cleanup.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address");
    return address.port;
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const remote = createServer(handler);
    const port = await listen(remote);
    let opened = 0;
    const pool = new RemoteProxyConnection(() => {
        opened++;
        return connect({ host: "127.0.0.1", port });
    });
    cleanup.push(() => pool.close());
    const gateway = createServer((req, res) => {
        void pool
            .forward(req, res, req.url!, async () => "remote-token")
            .catch((error) => {
                res.writeHead(error.status ?? 500, { "content-type": "application/json" });
                res.end(JSON.stringify({ code: error.code }));
            });
    });
    for (const event of ["upgrade", "connect"] as const) {
        gateway.on(event, (req, socket, head) => {
            void pool
                .forward(req, socket, req.url!, async () => "remote-token", head)
                .catch(() => socket.destroy());
        });
    }
    const gatewayPort = await listen(gateway);
    return {
        remote,
        pool,
        url: `http://127.0.0.1:${gatewayPort}`,
        opened: () => opened,
        gatewayPort,
    };
}

describe("remote HTTP proxy", () => {
    it("bounds concurrent health checks and releases pending work on close", async () => {
        const f = await fixture((_req, _res) => undefined);
        const pending = Array.from({ length: 32 }, () =>
            f.pool.health(async () => "token").catch((error: unknown) => error),
        );
        await expect(f.pool.health(async () => "token")).rejects.toMatchObject({
            status: 503,
            code: "remote_busy",
        });
        await f.pool.close();
        const results = await Promise.all(pending);
        expect(results).toHaveLength(32);
        expect(results.every((result) => result instanceof Error)).toBe(true);
    });
    it("checks authenticated health without exposing remote diagnostics", async () => {
        const f = await fixture((req, res) => {
            expect(req.url).toBe("/v0/health");
            expect(req.headers.authorization).toBe("Bearer health-token");
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    healthy: true,
                    ready: true,
                    status: "ready",
                    version: { protocol: 23, daemon: "private-diagnostic" },
                }),
            );
        });
        expect(await f.pool.health(async () => "health-token")).toEqual({
            reachable: true,
            authenticated: true,
            ready: true,
            protocol: 23,
        });
    });

    it("reports rejected health authentication without returning the remote body", async () => {
        const f = await fixture((_req, res) => {
            res.writeHead(401);
            res.end("sensitive remote diagnostic");
        });
        const health = await f.pool.health(async () => "wrong-token");
        expect(health).toMatchObject({ reachable: true, authenticated: false, ready: false });
        expect(JSON.stringify(health)).not.toContain("sensitive");
    });

    it("bounds a malformed health response", async () => {
        const f = await fixture((_req, res) => res.end("x".repeat(100_000)));
        await expect(f.pool.health(async () => "token")).rejects.toMatchObject({
            code: "remote_unavailable",
        });
    });
    it("preserves paths, body, conditional headers and errors while replacing credentials", async () => {
        const observed: unknown[] = [];
        const f = await fixture((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                observed.push({
                    method: req.method,
                    path: req.url,
                    headers: req.headers,
                    body: Buffer.concat(chunks).toString(),
                });
                res.writeHead(409, {
                    "content-type": "application/json",
                    etag: "remote-version",
                    "x-remote": "preserved",
                });
                res.end('{"code":"conflict"}');
            });
        });
        const response = await fetch(`${f.url}/v0/agents/abc/send?cursor=a%2Fb`, {
            method: "POST",
            body: '{"message":"hello"}',
            headers: {
                authorization: "Bearer main-secret",
                "if-match": "version",
                "proxy-authorization": "must-not-leak",
            },
        });
        expect(response.status).toBe(409);
        expect(response.headers.get("etag")).toBe("remote-version");
        expect(await response.json()).toEqual({ code: "conflict" });
        expect(observed).toMatchObject([
            {
                method: "POST",
                path: "/v0/agents/abc/send?cursor=a%2Fb",
                body: '{"message":"hello"}',
                headers: { authorization: "Bearer remote-token", "if-match": "version" },
            },
        ]);
        expect(JSON.stringify(observed)).not.toContain("main-secret");
        expect(JSON.stringify(observed)).not.toContain("must-not-leak");
    });

    it("reuses an established upstream connection without replaying mutations", async () => {
        let calls = 0;
        const f = await fixture((_req, res) => {
            calls++;
            res.end("ok");
        });
        for (let i = 0; i < 3; i++)
            expect(await (await fetch(f.url, { method: "POST" })).text()).toBe("ok");
        expect(calls).toBe(3);
        expect(f.opened()).toBe(1);
    });

    it("streams SSE before completion and closes the remote on client cancellation", async () => {
        let disconnected!: () => void;
        const closed = new Promise<void>((resolve) => {
            disconnected = resolve;
        });
        const f = await fixture((_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("event: hello\ndata: {}\n\n");
            res.once("close", disconnected);
        });
        const abort = new AbortController();
        const response = await fetch(f.url, { signal: abort.signal });
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: hello");
        abort.abort();
        await closed;
        await reader.cancel().catch(() => undefined);
    });

    it("terminates a broken streamed response instead of reporting successful EOF", async () => {
        let remoteResponse!: ServerResponse;
        const f = await fixture((_req, res) => {
            remoteResponse = res;
            res.writeHead(200);
            res.write("first");
        });
        const response = await fetch(f.url);
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        remoteResponse.destroy();
        await expect(reader.read()).rejects.toThrow();
    });

    it("does not follow redirects", async () => {
        let calls = 0;
        const f = await fixture((_req, res) => {
            calls++;
            res.writeHead(302, { location: "http://elsewhere.invalid" });
            res.end();
        });
        const response = await fetch(f.url, { redirect: "manual" });
        expect(response.status).toBe(302);
        expect(calls).toBe(1);
    });

    it("fails an ambiguous mutation once and keeps the gateway usable", async () => {
        let calls = 0;
        const f = await fixture((req, res) => {
            calls++;
            if (calls === 1) req.socket.destroy();
            else res.end("ok");
        });
        const response = await fetch(f.url, { method: "POST", body: "side-effect" });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "remote_unavailable" });
        expect(calls).toBe(1);
        expect(await (await fetch(f.url)).text()).toBe("ok");
    });

    it("closes active streams on removal and refuses new requests", async () => {
        const f = await fixture((_req, res) => {
            res.writeHead(200);
            res.write("open");
        });
        const response = await fetch(f.url);
        const reader = response.body!.getReader();
        await reader.read();
        f.pool.close();
        await expect(reader.read()).rejects.toThrow();
        expect((await fetch(f.url)).status).toBe(503);
    });

    it.each(["CONNECT", "websocket"])(
        "forwards %s with initial bytes and bidirectional traffic",
        async (kind) => {
            const f = await fixture((_req, res) => res.end());
            f.remote.on(kind === "CONNECT" ? "connect" : "upgrade", (req, socket, head) => {
                expect(req.headers.authorization).toBe("Bearer remote-token");
                socket.write(
                    kind === "CONNECT"
                        ? "HTTP/1.1 200 Connection Established\r\n\r\nremote-head"
                        : "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nremote-head",
                );
                if (head.length > 0) socket.write(head);
                socket.pipe(socket);
            });
            const req = request(f.url + "/v0/workspaces/test/proxy", {
                method: kind === "CONNECT" ? "CONNECT" : "GET",
                headers: kind === "CONNECT" ? {} : { connection: "Upgrade", upgrade: "websocket" },
            });
            const attached = once(req, kind === "CONNECT" ? "connect" : "upgrade");
            req.end();
            const [, socket, head] = (await attached) as [IncomingMessage, Socket, Buffer];
            try {
                let bytes = head.toString();
                socket.on("data", (chunk) => {
                    bytes += chunk.toString();
                });
                socket.write("client-data");
                await expect.poll(() => bytes).toBe("remote-headclient-data");
            } finally {
                socket.destroy();
            }
        },
    );
});
