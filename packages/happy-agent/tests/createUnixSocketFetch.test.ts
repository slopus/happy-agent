import { createServer, type RequestListener, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";

import { HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

import { createUnixSocketFetch } from "../sources/lifecycle/createUnixSocketFetch.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                }),
        ),
    );
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createUnixSocketFetch", () => {
    it("carries HappyAgentClient JSON requests over the Unix socket", async () => {
        const { client } = await serve((request, response) => {
            expect(request.url).toBe("/v0/health");
            expect(request.headers.authorization).toBe("Bearer token");
            response.setHeader("content-type", "application/json");
            response.end(
                JSON.stringify({
                    healthy: true,
                    ready: true,
                    status: "ready",
                    version: { daemon: "1.2.3", protocol: 17 },
                }),
            );
        });

        await expect(client.getHealth()).resolves.toEqual({
            healthy: true,
            ready: true,
            status: "ready",
            version: { daemon: "1.2.3", protocol: 17 },
        });
    });

    it("streams SSE frames without buffering the response", async () => {
        const { client } = await serve((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
                'event: hello\ndata: {"cursor":"01900000-0000-7000-8000-000000000000","gap":false,"resumed":true,"connectedAt":1}\n\n',
            );
            response.end(
                'id: 01900000-0000-7000-8000-000000000001\nevent: config.updated\ndata: {"cursor":"01900000-0000-7000-8000-000000000001","type":"config.updated","occurredAt":2,"payload":{}}\n\n',
            );
        });

        const frames = [];
        for await (const frame of client.streamEvents()) frames.push(frame);

        expect(frames.map((frame) => frame.kind)).toEqual(["hello", "event"]);
        expect(frames[1]).toMatchObject({
            event: { type: "config.updated" },
            kind: "event",
        });
    });

    it("contains late socket errors when the server rejects a buffered upload early", async () => {
        const { fetch } = await serveFetch((request, response) => {
            request.once("data", () => {
                response.writeHead(413, { "content-type": "application/json" });
                response.end(JSON.stringify({ code: "too_large", error: "Too large." }));
            });
        });

        const response = await fetch("http://happy/v0/upload", {
            body: Buffer.alloc(8 * 1024 * 1024 + 1),
            method: "PUT",
        });

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toEqual({
            code: "too_large",
            error: "Too large.",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it("does not share a stale socket across daemon client lifetimes", async () => {
        let firstSocket: Socket | undefined;
        let connectionCount = 0;
        const { fetch, socketPath } = await serveFetch((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                response.end(Buffer.concat(chunks));
            });
        });
        const server = servers.at(-1)!;
        server.on("connection", (socket) => {
            connectionCount += 1;
            firstSocket ??= socket;
        });

        const first = await fetch("http://happy/first", { body: "first", method: "POST" });
        await expect(first.text()).resolves.toBe("first");
        firstSocket?.destroy();

        const replacementFetch = createUnixSocketFetch(socketPath);
        const second = await replacementFetch("http://happy/second", {
            body: "second",
            method: "POST",
        });

        await expect(second.text()).resolves.toBe("second");
        expect(connectionCount).toBe(2);
    });
});

async function serve(listener: RequestListener): Promise<{ client: HappyAgentClient }> {
    const { fetch } = await serveFetch(listener);
    return {
        client: new HappyAgentClient({
            endpoint: "http://happy",
            fetch,
            token: "token",
        }),
    };
}

async function serveFetch(
    listener: RequestListener,
): Promise<{ fetch: typeof globalThis.fetch; socketPath: string }> {
    const localRoot = join(process.cwd(), "../../.local");
    await mkdir(localRoot, { recursive: true });
    const root = await mkdtemp(join(localRoot, "rig-fetch-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const server = createServer(listener);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        fetch: createUnixSocketFetch(socketPath),
        socketPath,
    };
}
