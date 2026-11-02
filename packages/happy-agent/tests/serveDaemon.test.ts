import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createHostCompute,
    RunnerHost,
    RunnerLink,
    type RunnerChannel,
    type RunnerLinkStatus,
} from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { connectRunnerWebSocket } from "../sources/runner/connectRunnerWebSocket.js";
import { serveDaemon } from "../sources/runner/serveDaemon.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The daemon's end of one runner WebSocket, as a runner channel. */
function serverChannel(webSocket: WebSocket): RunnerChannel {
    return {
        send: (frame) => webSocket.send(frame, { binary: true }),
        close: () => webSocket.close(),
        receive(receiver) {
            webSocket.on("message", (data: Buffer) => receiver.frame(new Uint8Array(data)));
            webSocket.on("close", () => receiver.close("The runner closed its connection."));
        },
    };
}

/** A daemon that accepts one runner over a WebSocket, and a runner dialing it. */
async function daemonAndRunner() {
    const directory = await mkdtemp(join(tmpdir(), "happy-serve-daemon-"));
    cleanups.push(async () => await rm(directory, { force: true, recursive: true }));
    const root = createRootContext();
    const link = new RunnerLink(root.named("test-link"), { name: "box", instanceId: "daemon-1" });
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on("connection", (webSocket) => {
        void link.accept(serverChannel(webSocket)).catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("The daemon has no port.");
    cleanups.push(
        async () =>
            await new Promise<void>((resolve) => {
                for (const client of sockets.clients) client.terminate();
                http.close(() => resolve());
            }),
    );
    const host = new RunnerHost({
        ctx: root.named("test-runner"),
        identity: {
            version: "9.9.9",
            platform: "linux",
            arch: "x64",
            hostname: "box",
            home: directory,
        },
        createCompute: async (computeCtx, request) =>
            createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
    });
    const stop = new AbortController();
    const serving = serveDaemon({
        ctx: root.named("test-serve"),
        host,
        connect: async () =>
            await connectRunnerWebSocket(
                `ws://127.0.0.1:${String(address.port)}/v0/runners/connect`,
                "token",
            ),
        stop: stop.signal,
        shutdownCtx: root.named("test-serve-shutdown"),
    });
    cleanups.push(async () => {
        stop.abort();
        await serving;
        link.close("The test ended.");
    });
    await statusBecomes(link, "connected");
    return { host, link, stop, serving };
}

async function statusBecomes(
    link: RunnerLink,
    state: RunnerLinkStatus["state"],
): Promise<RunnerLinkStatus> {
    if (link.status().state === state) return link.status();
    return await new Promise((resolve) => {
        const stop = link.onStatus((status) => {
            if (status.state !== state) return;
            stop();
            resolve(status);
        });
    });
}

describe("a runner serving its daemon", () => {
    it("says goodbye when it stops, so the daemon knows at once", async () => {
        const { link, stop, serving } = await daemonAndRunner();

        const startedAt = Date.now();
        stop.abort();
        const status = await statusBecomes(link, "disconnected");
        await serving;

        expect(Date.now() - startedAt).toBeLessThan(1_500);
        expect(status.reason).toBe("The runner is shutting down.");
    });

    it("lets go of everything at once when the daemon says goodbye", async () => {
        const { host, link } = await daemonAndRunner();
        const connection = await link.connection(1_000);
        await connection.request("compute.create", { computeId: "product", cwd: tmpdir() });
        expect(host.computeCount()).toBe(1);

        const startedAt = Date.now();
        link.close("The daemon is shutting down.");
        while (host.connected() || host.computeCount() > 0) {
            expect(Date.now() - startedAt).toBeLessThan(1_500);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    });
});
