import { createServer, type IncomingMessage, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createServeP2pHttpRequest } from "../createServeP2pHttpRequest.js";

describe("serving the local daemon API to an authenticated P2P peer", () => {
    it("injects the local token, filters headers, streams, and cancels the loopback request", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = `${directory}/server.sock`;
        const seen: IncomingMessage[] = [];
        let streamClosed = false;
        const server = createServer(async (request, response) => {
            seen.push(request);
            if (request.url === "/stream") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write("first");
                response.once("close", () => {
                    streamClosed = true;
                });
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            response.writeHead(201, { "content-type": "text/plain" });
            response.write("echo:");
            response.end(Buffer.concat(chunks));
        });
        await listen(server, socketPath);
        const serve = createServeP2pHttpRequest({
            allowRequest: () => true,
            socketPath,
            token: "remote-local-token",
        });
        try {
            const alreadyCancelled = new AbortController();
            alreadyCancelled.abort();
            await expect(
                serve(
                    "trusted-peer",
                    { body: new Uint8Array(), headers: {}, method: "GET", path: "/echo" },
                    alreadyCancelled.signal,
                ),
            ).rejects.toThrow("cancelled");
            expect(seen).toHaveLength(0);

            const response = await serve(
                "trusted-peer",
                {
                    body: Buffer.from("hello"),
                    headers: {
                        authorization: "must-not-cross",
                        cookie: "must-not-cross",
                        "content-type": "text/plain",
                        "x-rig-p2p-peer": "spoofed-peer",
                    },
                    method: "POST",
                    path: "/echo",
                },
                new AbortController().signal,
            );
            expect(response.status).toBe(201);
            expect(await collect(response.body)).toBe("echo:hello");
            expect(seen[0]!.headers).toMatchObject({
                authorization: "Bearer remote-local-token",
                "content-type": "text/plain",
                "x-rig-p2p-peer": "trusted-peer",
            });
            expect(seen[0]!.headers.cookie).toBeUndefined();

            const protectedResponse = await serve(
                "trusted-peer",
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/p2p/status" },
                new AbortController().signal,
            );
            expect(protectedResponse.status).toBe(403);
            expect(seen).toHaveLength(1);

            const narrow = createServeP2pHttpRequest({
                allowRequest: (_peerId, request) => request.path === "/config",
                socketPath,
                token: "remote-local-token",
            });
            const denied = await narrow(
                "trusted-peer",
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/echo" },
                new AbortController().signal,
            );
            expect(denied.status).toBe(403);
            const allowed = await narrow(
                "trusted-peer",
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/config" },
                new AbortController().signal,
            );
            expect(allowed.status).toBe(201);
            expect(seen.at(-1)?.url).toBe("/config");

            const cancellation = new AbortController();
            const streamed = await serve(
                "trusted-peer",
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/stream" },
                cancellation.signal,
            );
            const iterator = streamed.body[Symbol.asyncIterator]();
            await expect(iterator.next()).resolves.toMatchObject({ done: false });
            cancellation.abort();
            await vi.waitFor(() => expect(streamClosed).toBe(true));
        } finally {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        }
    });
});

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}
