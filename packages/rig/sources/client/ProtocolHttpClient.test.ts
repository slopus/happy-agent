import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProtocolHttpClient } from "./ProtocolHttpClient.js";

describe("ProtocolHttpClient", () => {
    it("keeps the process alive while reconnecting a session event stream", async () => {
        const directory = await mkdtemp("/tmp/rig-sse-reconnect-");
        const markerPath = join(directory, "observed");
        const socketPath = join(directory, "server.sock");
        let requests = 0;
        const server = createServer((request, response) => {
            requests += 1;
            if (requests === 1) {
                request.socket.destroy();
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
                `id: 0198a7d4-9372-7000-8000-000000000001\nevent: run_finished\ndata: ${JSON.stringify(
                    {
                        createdAt: Date.now(),
                        data: { runId: "run", stopReason: "stop" },
                        id: "0198a7d4-9372-7000-8000-000000000001",
                        sessionId: "session",
                        type: "run_finished",
                        worktreeSupport: "unknown",
                    },
                )}\n\n`,
            );
        });
        server.listen(socketPath);
        await once(server, "listening");

        try {
            const clientUrl = new URL("./ProtocolHttpClient.ts", import.meta.url).href;
            const script = `
                import { writeFile } from "node:fs/promises";
                import { ProtocolHttpClient } from ${JSON.stringify(clientUrl)};
                const controller = new AbortController();
                const client = new ProtocolHttpClient({
                    socketPath: ${JSON.stringify(socketPath)},
                    token: "test",
                });
                await client.watchSessionEvents({
                    onEvent: async () => {
                        await writeFile(${JSON.stringify(markerPath)}, "observed");
                        controller.abort();
                    },
                    sessionId: "session",
                    signal: controller.signal,
                });
            `;
            const child = spawn(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "--eval", script],
                { stdio: "ignore" },
            );
            const [code, signal] = await once(child, "exit");

            expect({ code, signal }).toEqual({ code: 0, signal: null });
            expect(requests).toBe(2);
            await expect(readFile(markerPath, "utf8")).resolves.toBe("observed");
        } finally {
            server.close();
            await once(server, "close");
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("stops reading the session stream while an event consumer is backpressured", async () => {
        const directory = await mkdtemp("/tmp/rig-sse-backpressure-");
        const socketPath = join(directory, "server.sock");
        const eventCount = 500;
        let ended = false;
        let written = 0;
        const server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            const pump = () => {
                while (written < eventCount) {
                    written += 1;
                    if (!response.write(sessionEventFrame(written))) {
                        response.once("drain", pump);
                        return;
                    }
                }
                ended = true;
                response.end();
            };
            pump();
        });
        server.listen(socketPath);
        await once(server, "listening");

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let observeFirst!: () => void;
        const firstObserved = new Promise<void>((resolve) => {
            observeFirst = resolve;
        });
        let received = 0;
        const client = new ProtocolHttpClient({ socketPath, token: "test" });
        const controller = new AbortController();

        try {
            const watching = client.watchSessionEvents({
                onEvent: async () => {
                    received += 1;
                    if (received === 1) {
                        observeFirst();
                        await firstGate;
                    }
                    if (received === eventCount) controller.abort();
                },
                sessionId: "session",
                signal: controller.signal,
            });

            await firstObserved;
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(received).toBe(1);
            expect(ended).toBe(false);

            releaseFirst();
            await watching;
            expect(received).toBe(eventCount);
            expect(ended).toBe(true);
        } finally {
            releaseFirst();
            server.close();
            await once(server, "close");
            await rm(directory, { force: true, recursive: true });
        }
    }, 10_000);

    it("propagates an event consumer failure instead of reconnecting", async () => {
        const directory = await mkdtemp("/tmp/rig-sse-consumer-error-");
        const socketPath = join(directory, "server.sock");
        let requests = 0;
        const server = createServer((_request, response) => {
            requests += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(sessionEventFrame(1));
        });
        server.listen(socketPath);
        await once(server, "listening");

        const client = new ProtocolHttpClient({ socketPath, token: "test" });
        try {
            await expect(
                client.watchSessionEvents({
                    onEvent: async () => {
                        throw new Error("stdout closed");
                    },
                    sessionId: "session",
                }),
            ).rejects.toThrow("stdout closed");
            expect(requests).toBe(1);
        } finally {
            server.close();
            await once(server, "close");
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function sessionEventFrame(index: number): string {
    const id = `0198a7d4-9372-7000-8000-${index.toString(16).padStart(12, "0")}`;
    return `id: ${id}\nevent: provider_event\ndata: ${JSON.stringify({
        createdAt: index,
        data: { padding: "x".repeat(4_096), runId: "run" },
        id,
        sessionId: "session",
        type: "provider_event",
        worktreeSupport: "unknown",
    })}\n\n`;
}
