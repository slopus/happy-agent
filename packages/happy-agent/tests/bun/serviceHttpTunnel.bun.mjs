import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";
import { ServiceHttpTunnel } from "../../../happy-agent-modules/sources/api/ServiceHttpTunnel.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serviceFixture() {
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    const sockets = new Set();
    const tunnels = new Set();
    const app = createServer((req, res) => {
        expect(req.headers.authorization).toBe("Bearer application-only");
        expect(req.headers.cookie).toBe("application=session");
        expect(req.headers["x-happy-service-authorization"]).toBeUndefined();
        req.pipe(res);
    });
    app.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        for (const tunnel of tunnels) tunnel.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => app.close(resolve));
    });
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: (token) => proxy.listenTcp(token),
            handleRequest: async (_ctx, _req, res) => res.end("healthy"),
            handleRemoteAttachment: async () => false,
            prepareWorkspaceProxySocket: async () => ({ handled: false }),
            handleServiceAttachment: async (_ctx, req, stream, head) => {
                // Exercise the adapter after the same asynchronous admission yield as real auth.
                await setImmediate();
                expect(req.headers.authorization).toBe("Bearer fixture-daemon");
                expect(req.headers["x-happy-service-authorization"]).toBe("Bearer fixture-service");
                const endpoint = connect(app.address().port, "127.0.0.1");
                await once(endpoint, "connect");
                const tunnel = new ServiceHttpTunnel(endpoint, () => tunnels.delete(tunnel));
                tunnels.add(tunnel);
                tunnel.accept(stream, head);
                return true;
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    return {
        app,
        async attach() {
            const socket = connect(listener.port, "127.0.0.1");
            cleanups.push(() => socket.destroy());
            const established = once(socket, "data");
            socket.write(
                "CONNECT /v0/workspaces/workspace/services/service/proxy HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer fixture-daemon\r\nX-Happy-Service-Authorization: Bearer fixture-service\r\n\r\n",
            );
            expect((await established)[0].toString()).toBe(
                "HTTP/1.1 200 Connection Established\r\n\r\n",
            );
            return socket;
        },
    };
}

test("native Bun service CONNECT streams chunked HTTP and preserves application credentials", async () => {
    const f = await serviceFixture();
    const socket = await f.attach();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => socket;
    cleanups.push(() => agent.destroy());
    const body = "streamed 🦊".repeat(20000);
    const reply = await new Promise((resolve, reject) => {
        const req = request(
            {
                host: "preview.localhost",
                agent,
                method: "POST",
                path: "/echo",
                headers: {
                    authorization: "Bearer application-only",
                    cookie: "application=session",
                    "transfer-encoding": "chunked",
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("error", reject);
                res.once("end", () => resolve(Buffer.concat(chunks).toString()));
            },
        );
        req.on("error", reject);
        req.end(body);
    });
    expect(reply).toBe(body);
}, 5000);

test("native Bun service CONNECT upgrades to bidirectional binary WebSockets", async () => {
    const f = await serviceFixture();
    const server = new WebSocketServer({ noServer: true });
    cleanups.push(() => {
        for (const peer of server.clients) peer.terminate();
        server.close();
    });
    f.app.on("upgrade", (req, socket, head) =>
        server.handleUpgrade(req, socket, head, (peer) =>
            peer.on("message", (bytes) => peer.send(bytes)),
        ),
    );
    const stream = await f.attach();
    // Bun's built-in ws client ignores createConnection and would dial the fixture hostname
    // directly. Speak an RFC 6455 handshake and masked binary frame on the actual attachment.
    const opened = once(stream, "data");
    stream.write(
        "GET /socket HTTP/1.1\r\nHost: preview.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const handshake = (await opened)[0].toString();
    expect(handshake).toContain("101");
    expect(handshake.toLowerCase()).toContain("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=");
    const reply = once(stream, "data");
    const payload = Buffer.from([0, 255, 1, 128]);
    const mask = Buffer.from([11, 22, 33, 44]);
    stream.write(
        Buffer.concat([
            Buffer.from([0x82, 0x84]),
            mask,
            payload.map((byte, index) => byte ^ mask[index]),
        ]),
    );
    expect((await reply)[0]).toEqual(Buffer.concat([Buffer.from([0x82, 4]), payload]));
}, 5000);
