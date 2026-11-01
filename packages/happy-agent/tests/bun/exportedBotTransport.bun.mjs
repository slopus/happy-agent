import { afterEach, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";
import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    const observed = [];
    let socket;
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: () => proxy.listenTcp(),
            handleRequest: async (_ctx, _request, response) => response.end("healthy"),
            prepareTerminalSocket: async () => ({ handled: false }),
            prepareRunnerSocket: () => ({ handled: false }),
            prepareLiveSocket: async () => ({ handled: false }),
            publicSocketRejection: async () => undefined,
            prepareWorkspaceProxyWebSocket: async () => ({ handled: false }),
            prepareBridgeSocket: async () => ({ handled: false }),
            prepareExportedBotSocket: async (_ctx, url, authorization) => {
                await setImmediate();
                if (url.pathname !== "/v0/exported-bots/connect") return { handled: false };
                if (authorization !== "Bearer bridge-fixture-token")
                    return {
                        handled: true,
                        rejection: {
                            status: 401,
                            code: "unauthorized",
                            message: "The bridge token was refused.",
                        },
                    };
                return {
                    handled: true,
                    attach: (attached) => {
                        socket = attached;
                        attached.send(JSON.stringify({ type: "hello", protocol: 1 }));
                        return {
                            message: (text) => {
                                observed.push(text === undefined ? "binary" : JSON.parse(text));
                                if (text === undefined) {
                                    attached.close(1003, "Frames must be text.");
                                    return;
                                }
                                attached.ping();
                            },
                            pong: () => observed.push("pong"),
                            closed: () => observed.push("closed"),
                        };
                    },
                };
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    const url = `${listener.url.replace("http:", "ws:")}/v0/exported-bots/connect`;
    return { url, observed, socket: () => socket };
}

function connect(url, token) {
    const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 2000,
    });
    cleanups.push(() => socket.terminate());
    return socket;
}

async function until(check) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The expected state never arrived.");
}

test("Bun admits a bridge on the exported-bot route and carries its JSON frames and pings", async () => {
    const f = await fixture();
    const socket = connect(f.url, "bridge-fixture-token");
    const hello = await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (data, binary) =>
            resolve({ frame: JSON.parse(data.toString()), binary }),
        );
    });
    expect(hello).toEqual({ frame: { type: "hello", protocol: 1 }, binary: false });
    socket.send(JSON.stringify({ type: "message", text: "Hi" }));
    await until(() => f.observed.includes("pong"));
    expect(f.observed).toEqual([{ type: "message", text: "Hi" }, "pong"]);
    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(Buffer.from("binary is not a bridge frame"));
    expect(await closed).toBe(1003);
    await until(() => f.observed.includes("closed"));
    expect(f.observed).toEqual([{ type: "message", text: "Hi" }, "pong", "binary", "closed"]);
}, 5000);

test("Bun closes an oversized bridge frame and lets the export terminate its socket", async () => {
    const f = await fixture();
    const oversized = connect(f.url, "bridge-fixture-token");
    await new Promise((resolve, reject) => {
        oversized.once("error", reject);
        oversized.once("message", resolve);
    });
    const tooLarge = new Promise((resolve) => oversized.once("close", (code) => resolve(code)));
    oversized.send(JSON.stringify({ type: "message", text: "x".repeat(1024 * 1024) }));
    expect(await tooLarge).toBe(1009);

    const terminated = connect(f.url, "bridge-fixture-token");
    await new Promise((resolve, reject) => {
        terminated.once("error", reject);
        terminated.once("message", resolve);
    });
    const gone = new Promise((resolve) => terminated.once("close", (code) => resolve(code)));
    f.socket().terminate();
    expect(await gone).toBe(1006);
}, 5000);

test("Bun refuses a bridge token before the upgrade with the export's own rejection", async () => {
    const f = await fixture();
    const socket = connect(f.url, "stale-token");
    const refusal = await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () =>
                resolve({ status: response.statusCode, body: JSON.parse(body) }),
            );
        });
    });
    expect(refusal).toEqual({
        status: 401,
        body: { code: "unauthorized", error: "The bridge token was refused." },
    });
    expect(f.observed).toEqual([]);
}, 5000);
