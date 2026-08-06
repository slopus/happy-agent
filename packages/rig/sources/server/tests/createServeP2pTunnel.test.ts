import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createServeP2pTunnel } from "../createServeP2pTunnel.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("serving P2P tunnels through the local daemon socket", () => {
    it("injects the remote token and preserves WebSocket upgrade head bytes", async () => {
        const { server, socketPath } = await startServer();
        let receivedHeaders: Record<string, string | string[] | undefined> | undefined;
        let receivedClientBytes = "";
        server.on("upgrade", (request, socket) => {
            receivedHeaders = request.headers;
            socket.on("data", (chunk) => {
                receivedClientBytes += chunk.toString("utf8");
            });
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nwelcome",
            );
        });
        const serve = createServeP2pTunnel({ socketPath, token: "remote-token" });
        const connection = await serve(
            "peer-id",
            {
                headers: {
                    authorization: "Bearer local-token",
                    connection: "Upgrade",
                    "sec-websocket-key": "abc",
                    "sec-websocket-version": "13",
                    upgrade: "websocket",
                },
                method: "GET",
                path: "/projects/project/terminals/terminal/attach",
            },
            new AbortController().signal,
        );

        expect(connection.response.status).toBe(101);
        expect(receivedHeaders?.authorization).toBe("Bearer remote-token");
        expect(receivedHeaders?.["x-rig-p2p-peer"]).toBe("peer-id");
        connection.stream.write("client");
        connection.stream.resume();
        const [welcome] = (await once(connection.stream, "data")) as [Buffer];
        await vi.waitFor(() => expect(receivedClientBytes).toBe("client"));
        expect(welcome.toString()).toBe("welcome");
        connection.stream.destroy();
    });

    it("refuses every tunnel target except terminal attachment and the scoped proxy", async () => {
        const { server, socketPath } = await startServer();
        const seen = vi.fn();
        server.on("request", seen);
        const serve = createServeP2pTunnel({ socketPath, token: "remote-token" });

        const connection = await serve(
            "peer-id",
            { headers: {}, method: "CONNECT", path: "/shutdown" },
            new AbortController().signal,
        );

        expect(connection.response.status).toBe(403);
        expect(seen).not.toHaveBeenCalled();
        connection.stream.destroy();
    });
});

async function startServer(): Promise<{ server: Server; socketPath: string }> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createServer();
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { force: true, recursive: true });
    });
    return { server, socketPath };
}
