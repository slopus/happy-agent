import { localAgentSocketPath } from "@slopus/happy-agent-compute";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBunHttpForwarder } from "../sources/socket/createBunHttpForwarder.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(handler: RequestListener) {
    const scratch = resolve("../../.context");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(`${scratch}/f`);
    const path = process.platform === "win32" ? localAgentSocketPath(root) : `${root}/s`;
    const server = createServer(handler);
    const sockets = new Set<Socket>();
    let connections = 0;
    server.on("connection", (socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    const forwarder = createBunHttpForwarder(path);
    cleanups.push(async () => {
        forwarder.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
    });
    server.listen(path);
    await once(server, "listening");
    return { ...forwarder, connections: () => connections };
}

describe("native Bun HTTP forwarding", () => {
    it("reuses connections while preserving request identity and end-to-end headers", async () => {
        const identities: string[] = [];
        const f = await fixture((request, response) => {
            identities.push(request.headers.authorization!);
            expect(request.url).toBe("/v0/test?q=a%2Fb");
            expect(request.headers["x-hop"]).toBeUndefined();
            response.writeHead(200, {
                "cache-control": "private, max-age=3600",
                etag: '"version"',
                "set-cookie": ["first=1", "second=2"],
            });
            response.end("ok");
        });
        for (const identity of ["Bearer first", "Bearer second"]) {
            const response = await f.forward(
                new Request("http://happy/v0/test?q=a%2Fb", {
                    headers: {
                        authorization: identity,
                        connection: "keep-alive, x-hop",
                        "x-hop": "private",
                    },
                }),
            );
            expect(await response.text()).toBe("ok");
            expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
            expect(response.headers.get("etag")).toBe('"version"');
            expect(response.headers.getSetCookie()).toEqual(["first=1", "second=2"]);
            expect(response.headers.get("connection")).toBeNull();
        }
        expect(identities).toEqual(["Bearer first", "Bearer second"]);
        expect(f.connections()).toBe(1);
    });

    it("streams uploads and responses without waiting for the complete body", async () => {
        const f = await fixture((request, response) => {
            request.on("data", (chunk) => response.write(chunk));
            request.on("end", () => response.end());
        });
        let upload!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                upload = controller;
            },
        });
        const pending = f.forward(
            new Request("http://happy/stream", {
                method: "POST",
                body,
                duplex: "half",
            } as RequestInit),
        );
        upload.enqueue(new TextEncoder().encode("first"));
        const response = await pending;
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        upload.enqueue(new TextEncoder().encode("second"));
        upload.close();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
        expect((await reader.read()).done).toBe(true);
    });

    it.each([204, 304])(
        "preserves a bodyless %i without constructing an invalid Response",
        async (status) => {
            const f = await fixture((_request, response) => {
                response.writeHead(status);
                response.end();
            });
            const response = await f.forward(new Request("http://happy/empty"));
            expect(response.status).toBe(status);
            expect(response.body).toBeNull();
            expect(await response.text()).toBe("");
        },
    );

    it("cancels the upstream stream when the client disconnects", async () => {
        let closed!: () => void;
        const disconnected = new Promise<void>((resolve) => {
            closed = resolve;
        });
        const f = await fixture((_request, response) => {
            response.once("close", closed);
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: ready\n\n");
        });
        const abort = new AbortController();
        const response = await f.forward(
            new Request("http://happy/events", { signal: abort.signal }),
        );
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
        abort.abort();
        await disconnected;
        await reader.cancel().catch(() => undefined);
    });

    it("does not replay a failed request and rejects work after shutdown", async () => {
        let calls = 0;
        const f = await fixture((request) => {
            calls++;
            request.socket.destroy();
        });
        await expect(
            f.forward(new Request("http://happy/mutation", { method: "POST" })),
        ).rejects.toThrow();
        expect(calls).toBe(1);
        f.close();
        await expect(f.forward(new Request("http://happy/health"))).rejects.toThrow("stopped");
    });
});
