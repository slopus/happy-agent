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
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: (token) => proxy.listenTcp(token),
            handleRequest: async (_ctx, _request, response) => response.end("healthy"),
            prepareTerminalSocket: async () => ({ handled: false }),
            prepareRunnerSocket: () => ({ handled: false }),
            prepareLiveSocket: async (_ctx, url, authorization) => {
                await setImmediate();
                if (authorization !== "Bearer live-fixture-token")
                    return {
                        handled: true,
                        rejection: { status: 401, code: "unauthorized", message: "Unauthorized" },
                    };
                if (
                    url.pathname !== "/v0/live/sessions/livefixture/control" ||
                    url.searchParams.get("windowId") !== "window-fixture"
                )
                    return {
                        handled: true,
                        rejection: {
                            status: 409,
                            code: "conflict",
                            message: "The voice window does not match.",
                        },
                    };
                return {
                    handled: true,
                    failed: () => observed.push("upgrade failed"),
                    attach: (socket) => {
                        socket.send(
                            JSON.stringify({
                                type: "hello",
                                sessionId: "livefixture",
                                windowId: "window-fixture",
                                contextRevision: 1,
                            }),
                        );
                        return {
                            message: (text) => {
                                if (text === "") {
                                    socket.close(1008, "Invalid voice frame.");
                                    return;
                                }
                                observed.push(JSON.parse(text));
                                socket.send(
                                    JSON.stringify({
                                        type: "status",
                                        status: "active",
                                        error: null,
                                    }),
                                );
                            },
                            closed: () => observed.push("closed"),
                        };
                    },
                };
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    const url = `${listener.url.replace("http:", "ws:")}/v0/live/sessions/livefixture/control?windowId=window-fixture`;
    return { url, observed };
}

test("Bun carries UTF-8 Live JSON after asynchronous authenticated admission", async () => {
    const f = await fixture();
    const socket = new WebSocket(f.url, {
        headers: { authorization: "Bearer live-fixture-token" },
        handshakeTimeout: 2000,
    });
    cleanups.push(() => socket.terminate());
    const hello = await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (data, binary) =>
            resolve({ frame: JSON.parse(data.toString()), binary }),
        );
    });
    expect(hello).toEqual({
        frame: {
            type: "hello",
            sessionId: "livefixture",
            windowId: "window-fixture",
            contextRevision: 1,
        },
        binary: false,
    });
    const response = new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    const result = {
        type: "actionResult",
        actionId: "action",
        result: { status: "succeeded", output: { type: "staged" } },
    };
    socket.send(JSON.stringify(result));
    expect(await response).toEqual({ type: "status", status: "active", error: null });
    expect(f.observed).toEqual([result]);
    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(Buffer.from("binary is not JSON text"));
    expect(await closed).toBe(1008);
}, 5000);

test("Bun preserves Live authentication and window query rejection", async () => {
    const f = await fixture();
    for (const [url, token, expected] of [
        [f.url, "bad", 401],
        [f.url.replace("window-fixture", "other-window"), "live-fixture-token", 409],
    ]) {
        const status = await new Promise((resolve, reject) => {
            const socket = new WebSocket(url, {
                headers: { authorization: `Bearer ${token}` },
                handshakeTimeout: 2000,
            });
            cleanups.push(() => socket.terminate());
            socket.once("error", reject);
            socket.once("unexpected-response", (_request, response) => {
                response.resume();
                resolve(response.statusCode);
            });
        });
        expect(status).toBe(expected);
    }
    expect(f.observed).toEqual([]);
}, 5000);
