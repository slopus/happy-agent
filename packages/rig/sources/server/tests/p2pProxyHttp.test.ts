import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { P2pHttpRequest, P2pNetwork, P2pTunnelRequestHead } from "../../p2p/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const peerId = "aremoteinstance0000000001";

describe("P2P-prefixed daemon HTTP", () => {
    it("forwards a request and streams the peer response", async () => {
        const fetch = vi.fn(
            async (_peerId: string, _request: P2pHttpRequest, _signal: AbortSignal) => ({
                response: {
                    body: (async function* () {
                        yield Buffer.from("first");
                        yield Buffer.from("second");
                    })(),
                    headers: { "content-type": "text/plain" },
                    status: 202,
                },
                transport: "iroh" as const,
            }),
        );
        const started = await startServer({ fetch } as unknown as P2pNetwork);
        try {
            const result = await sendRequest(
                started.socketPath,
                `/p2p/peers/${peerId}/api/messages?scope=all`,
                {
                    authorization: "Bearer test-token",
                    "content-type": "text/plain",
                    cookie: "must-not-cross",
                    "x-rig-mutation-id": "mutation-one",
                },
                "request body",
            );

            expect(result).toEqual({
                body: "firstsecond",
                headers: expect.objectContaining({
                    "content-type": "text/plain",
                    "x-rig-p2p-peer": peerId,
                    "x-rig-p2p-transport": "iroh",
                }),
                status: 202,
            });
            expect(fetch).toHaveBeenCalledOnce();
            const [forwardedPeerId, forwarded, signal] = fetch.mock.calls[0]!;
            expect(forwardedPeerId).toBe(peerId);
            expect(forwarded).toMatchObject({
                headers: {
                    "content-type": "text/plain",
                    "x-rig-mutation-id": "mutation-one",
                },
                method: "POST",
                path: "/messages?scope=all",
            });
            expect(Buffer.from(forwarded.body).toString("utf8")).toBe("request body");
            expect(signal).toBeInstanceOf(AbortSignal);
        } finally {
            await started.close();
        }
    });

    it("keeps the prefix authenticated and refuses recursive P2P forwarding", async () => {
        const fetch = vi.fn();
        const started = await startServer({ fetch } as unknown as P2pNetwork);
        try {
            await expect(
                sendRequest(started.socketPath, `/p2p/peers/${peerId}/api/health`, {}),
            ).resolves.toMatchObject({ status: 401 });
            await expect(
                sendRequest(started.socketPath, `/p2p/peers/${peerId}/api/p2p/status`, {
                    authorization: "Bearer test-token",
                }),
            ).resolves.toMatchObject({ status: 403 });
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            await started.close();
        }
    });

    it("forwards terminal upgrades and scoped browser CONNECT tunnels", async () => {
        const requests: P2pTunnelRequestHead[] = [];
        const openTunnel = vi.fn(async (_peerId, tunnel: P2pTunnelRequestHead) => {
            requests.push(tunnel);
            return {
                connection: {
                    response: {
                        headers:
                            tunnel.method === "GET"
                                ? { connection: "Upgrade", upgrade: "websocket" }
                                : {},
                        status: tunnel.method === "GET" ? 101 : 200,
                    },
                    stream: new PassThrough(),
                },
                transport: "direct" as const,
            };
        });
        const started = await startServer({ openTunnel } as unknown as P2pNetwork);
        try {
            const upgrade = await openRawTunnel(
                started.socketPath,
                "GET",
                `/p2p/peers/${peerId}/api/projects/project/terminals/terminal/attach`,
                {
                    authorization: "Bearer test-token",
                    connection: "Upgrade",
                    "sec-websocket-key": "abc",
                    "sec-websocket-version": "13",
                    upgrade: "websocket",
                },
            );
            expect(upgrade.status).toBe(101);
            upgrade.socket.destroy();
            const connect = await openRawTunnel(
                started.socketPath,
                "CONNECT",
                `/p2p/peers/${peerId}/api/projects/project/workspaces/workspace/proxy`,
                { authorization: "Bearer test-token" },
            );
            expect(connect.status).toBe(200);
            connect.socket.destroy();

            expect(requests).toEqual([
                expect.objectContaining({
                    method: "GET",
                    path: "/projects/project/terminals/terminal/attach",
                }),
                {
                    headers: {},
                    method: "CONNECT",
                    path: "/projects/project/workspaces/workspace/proxy",
                },
            ]);
        } finally {
            await started.close();
        }
    });
});

async function startServer(p2pNetwork: P2pNetwork): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({ p2pNetwork, token: "test-token" });
    await listen(server, socketPath);
    return {
        close: async () => {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}

function sendRequest(
    socketPath: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body = "",
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers, method: body.length === 0 ? "GET" : "POST", path, socketPath },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}

function openRawTunnel(
    socketPath: string,
    method: "CONNECT" | "GET",
    path: string,
    headers: Readonly<Record<string, string>>,
): Promise<{ socket: import("node:stream").Duplex; status: number }> {
    return new Promise((resolve, reject) => {
        const outgoing = request({ headers, method, path, socketPath });
        const opened = (
            response: import("node:http").IncomingMessage,
            socket: import("node:stream").Duplex,
        ) => resolve({ socket, status: response.statusCode ?? 0 });
        outgoing.once(method === "GET" ? "upgrade" : "connect", opened);
        outgoing.once("error", reject);
        outgoing.end();
    });
}
