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

async function fixture(handler: RequestListener, idleTimeoutMs?: number) {
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
    const forwarder = createBunHttpForwarder(path, idleTimeoutMs);
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

    it("drops the length of a body Bun discarded so the next request keeps its own bytes", async () => {
        const seen: string[] = [];
        const f = await fixture((request, response) => {
            seen.push(`${request.url} ${String(request.headers["content-length"])}`);
            response.end("ok");
        });
        // Bun hands a GET over without its body but with its Content-Length.
        const first = await f.forward(
            new Request("http://happy/first", { headers: { "content-length": "4096" } }),
        );
        expect(await first.text()).toBe("ok");
        const second = await f.forward(new Request("http://happy/second"));
        expect(second.status).toBe(200);
        expect(await second.text()).toBe("ok");
        expect(seen).toEqual(["/first undefined", "/second undefined"]);
        expect(f.connections()).toBe(1);
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

    it("lets an upload outlast the timeout while its body progresses, and times out silence", async () => {
        const f = await fixture((request, response) => {
            let size = 0;
            request.on("data", (chunk: Buffer) => (size += chunk.length));
            request.on("end", () => response.end(String(size)));
        }, 300);
        const upload = (gapMs: number) =>
            f.forward(
                new Request("http://happy/upload", {
                    method: "POST",
                    body: new ReadableStream<Uint8Array>({
                        async start(controller) {
                            for (let chunk = 0; chunk < 6; chunk++) {
                                controller.enqueue(new Uint8Array(1024));
                                await new Promise((done) => setTimeout(done, gapMs));
                            }
                            controller.close();
                        },
                    }),
                    duplex: "half",
                } as RequestInit),
            );
        // Six chunks 150 ms apart take 900 ms in all, three times the idle timeout.
        expect(await (await upload(150)).text()).toBe(String(6 * 1024));
        await expect(upload(600)).rejects.toThrow("timed out");
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
