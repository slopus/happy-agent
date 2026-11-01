import { afterEach, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";
import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reason = { code: "vhci_not_loaded", message: "Load vhci-hcd on the workspace's machine." };

async function fixture() {
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    const observed = [];
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: () => proxy.listenTcp(),
            handleRequest: async (_ctx, _request, response) => response.end("healthy"),
            prepareTerminalSocket: async () => ({ handled: false }),
            prepareRunnerSocket: () => ({ handled: false }),
            prepareExportedBotSocket: async () => ({ handled: false }),
            prepareLiveSocket: async () => ({ handled: false }),
            publicSocketRejection: async () => undefined,
            prepareWorkspaceProxyWebSocket: async () => ({ handled: false }),
            prepareBridgeSocket: async (_ctx, url, authorization) => {
                // Real admission reads catalogs and binds listeners before answering.
                await setImmediate();
                if (!url.pathname.startsWith("/v0/workspaces/w1/bridges/"))
                    return { handled: false };
                if (authorization !== "Bearer bridge-fixture-token")
                    return {
                        handled: true,
                        rejection: { status: 401, code: "unauthorized", message: "Unauthorized" },
                    };
                if (url.pathname.endsWith("/usb") && url.searchParams.get("busId") === "9-9")
                    return {
                        handled: true,
                        rejection: {
                            status: 409,
                            code: "bridge_unavailable",
                            message: reason.message,
                            details: { reason },
                        },
                    };
                return {
                    handled: true,
                    failed: () => observed.push("upgrade failed"),
                    attach: (socket) => {
                        if (url.pathname.endsWith("/usb"))
                            socket.send(Buffer.from([1, 17, 128, 3]));
                        else socket.send(JSON.stringify({ type: "ready" }));
                        return {
                            message: (data) => {
                                observed.push(typeof data === "string" ? data : [...data]);
                                if (typeof data === "string") socket.close(4400, "Binary only.");
                                else socket.send(data);
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
    const base = `${listener.url.replace("http:", "ws:")}/v0/workspaces/w1/bridges`;
    return { base, observed };
}

function connectSocket(url) {
    const socket = new WebSocket(url, {
        headers: { authorization: "Bearer bridge-fixture-token" },
        handshakeTimeout: 2000,
    });
    cleanups.push(() => socket.terminate());
    return socket;
}

function nextMessage(socket) {
    return new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (data, binary) => resolve({ data, binary }));
    });
}

test("Bun carries binary bridge bytes both ways and the bridge's own close codes", async () => {
    const f = await fixture();
    const socket = connectSocket(`${f.base}/usb?busId=1-2`);
    const first = await nextMessage(socket);
    expect(first.binary).toBe(true);
    expect([...first.data]).toEqual([1, 17, 128, 3]);

    const echoed = nextMessage(socket);
    socket.send(Buffer.from([0, 0, 0, 1]));
    expect([...(await echoed).data]).toEqual([0, 0, 0, 1]);

    const closed = new Promise((resolve) =>
        socket.once("close", (code, why) => resolve([code, why.toString()])),
    );
    socket.send("text is a protocol violation");
    expect(await closed).toEqual([4400, "Binary only."]);
    expect(f.observed).toEqual([[0, 0, 0, 1], "text is a protocol violation", "closed"]);
}, 5000);

test("Bun carries a port bridge's JSON control messages as text", async () => {
    const f = await fixture();
    const socket = connectSocket(`${f.base}/port?port=0`);
    const ready = await nextMessage(socket);
    expect(ready.binary).toBe(false);
    expect(JSON.parse(ready.data.toString())).toEqual({ type: "ready" });
}, 5000);

test("Bun refuses an unavailable bridge with its reason before upgrading", async () => {
    const f = await fixture();
    const refusal = await new Promise((resolve, reject) => {
        const socket = connectSocket(`${f.base}/usb?busId=9-9`);
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
        status: 409,
        body: { error: reason.message, code: "bridge_unavailable", reason },
    });
    expect(f.observed).toEqual([]);
}, 5000);

test("Bun closes a bridge message larger than a mebibyte", async () => {
    const f = await fixture();
    const socket = connectSocket(`${f.base}/usb?busId=1-2`);
    await nextMessage(socket);
    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(Buffer.alloc(1024 * 1024 + 1));
    expect(await closed).toBe(1009);
}, 5000);
