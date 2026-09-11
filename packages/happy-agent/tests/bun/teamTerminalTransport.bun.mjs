import { afterEach, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("team terminal upgrades survive asynchronous authentication and carry binary frames", async () => {
    const webSockets = new WebSocketServer({ noServer: true });
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    cleanups.push(() => {
        for (const socket of webSockets.clients) socket.terminate();
        webSockets.close();
    });
    const prepareTerminalSocket = async (_ctx, _path, authorization) => {
        // Real WorkOS verification and the user lookup yield before upgrading.
        await setImmediate();
        if (authorization !== "Bearer test-team-token") {
            return {
                handled: true,
                rejection: { status: 401, code: "unauthorized", message: "Unauthorized" },
            };
        }
        return { handled: true, attach: (stream) => stream.pipe(stream) };
    };
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: (token) => proxy.listenTcp(token),
            handleRequest: (_ctx, _request, response) => {
                response.end("healthy");
                return Promise.resolve();
            },
            prepareTerminalSocket,
            handleUpgrade: async (ctx, request, socket, head) => {
                await prepareTerminalSocket(ctx, request.url, request.headers.authorization);
                webSockets.handleUpgrade(request, socket, head, (ws) => {
                    ws.on("message", (data) => ws.send(data));
                });
                return true;
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    expect(await (await fetch(listener.url)).text()).toBe("healthy");
    const socket = new WebSocket(
        `${listener.url.replace("http:", "ws:")}/v0/workspaces/workspace/terminals/terminal/attach`,
        {
            headers: { authorization: "Bearer test-team-token" },
            handshakeTimeout: 2_000,
            perMessageDeflate: false,
        },
    );
    cleanups.push(() => socket.terminate());
    const frame = Buffer.from([0, 255, 1, 2, 3]);
    const echoed = await new Promise((resolve, reject) => {
        socket.on("error", reject);
        socket.once("open", () => socket.send(frame));
        socket.once("message", resolve);
    });
    expect(Buffer.from(echoed)).toEqual(frame);
}, 5_000);
