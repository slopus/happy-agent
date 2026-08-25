import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
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

    it.each([
        {
            body: "你好🙂",
            expected: Buffer.from("你好🙂"),
            name: "a UTF-8 string",
        },
        {
            body: new URLSearchParams([
                ["person", "Steve Korshakov"],
                ["city", "广州"],
            ]),
            expected: Buffer.from("person=Steve+Korshakov&city=%E5%B9%BF%E5%B7%9E"),
            name: "URLSearchParams",
        },
        {
            body: Uint8Array.from([0, 1, 2, 127, 128, 255]),
            expected: Buffer.from([0, 1, 2, 127, 128, 255]),
            name: "a Uint8Array",
        },
        {
            body: Uint8Array.from([9, 8, 7, 6]).buffer,
            expected: Buffer.from([9, 8, 7, 6]),
            name: "an ArrayBuffer",
        },
    ])("sets the byte-accurate content length for $name", async ({ body, expected }) => {
        const { fetch } = await serveInspection(async (request) => {
            const bytes = await readRequest(request);
            return {
                body: bytes.toString("base64"),
                contentLength: request.headers["content-length"],
            };
        });

        const response = await fetch("http://happy/upload", { body, method: "POST" });

        await expect(response.json()).resolves.toEqual({
            body: expected.toString("base64"),
            contentLength: String(expected.byteLength),
        });
    });

    it("preserves a caller-supplied content-length header", async () => {
        const { fetch } = await serveInspection(async (request) => ({
            body: (await readRequest(request)).toString("utf8"),
            contentLength: request.headers["content-length"],
        }));

        const response = await fetch("http://happy/upload", {
            body: "exact",
            headers: { "content-length": "5" },
            method: "POST",
        });

        await expect(response.json()).resolves.toEqual({ body: "exact", contentLength: "5" });
    });
});

async function serveInspection(
    inspect: (request: IncomingMessage) => Promise<Record<string, unknown>>,
): Promise<{ fetch: typeof globalThis.fetch }> {
    return await serveFetch((request, response) => {
        void inspect(request).then(
            (result) => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(result));
            },
            (error: unknown) => {
                response.destroy(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

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

async function readRequest(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
}
