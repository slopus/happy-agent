import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createUnixSocketFetch } from "../sources/createUnixSocketFetch.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolveClose) => {
                    server.close(() => resolveClose());
                }),
        ),
    );
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createUnixSocketFetch", () => {
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

async function serveFetch(
    listener: RequestListener,
): Promise<{ fetch: typeof globalThis.fetch; socketPath: string }> {
    const localRoot = resolve(import.meta.dirname, "../../../.local");
    await mkdir(localRoot, { recursive: true });
    const root = await mkdtemp(join(localRoot, "gym-fetch-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const server = createServer(listener);
    servers.push(server);
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    return { fetch: createUnixSocketFetch(socketPath), socketPath };
}
