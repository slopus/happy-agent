import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";

import {
    BridgeUpgradeError,
    connectBridgeWebSocket,
    createAgentGym,
    type AgentGym,
    type GymBridgeWebSocket,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("WebSocket tunnels", () => {
    it("advertises the twins and carries proxied HTTP like the CONNECT tunnel", async () => {
        const gym = await started();
        expect((await gym.client.getHealth()).capabilities).toMatchObject({
            webSocketTunnels: true,
        });
        const workspaceId = await rootWorkspace(gym);
        const site = await httpFixture((request, response) => {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end(`site saw ${request.url ?? ""} with ${request.headers.cookie ?? ""}`);
        });

        const tunnel = await open(gym, `/v0/workspaces/${workspaceId}/proxy/websocket`);
        tunnel.send(
            Buffer.from(
                `GET http://127.0.0.1:${String(site)}/page HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: a=b\r\nConnection: close\r\n\r\n`,
            ),
        );

        const reply = await readUntil(tunnel, (text) => text.includes("site saw"));
        expect(reply).toMatch(/^HTTP\/1\.1 200 /u);
        expect(reply).toContain("site saw /page with a=b");
        tunnel.close();
        expect(gym.errors).toEqual([]);
    });

    it("carries a nested CONNECT, half-closes with an empty message, and then closes normally", async () => {
        const gym = await started();
        const workspaceId = await rootWorkspace(gym);
        const echo = await tcpFixture((socket) => {
            const received: Buffer[] = [];
            socket.on("data", (chunk) => received.push(chunk));
            // The destination answers only after the client's half-close reaches it.
            socket.on("end", () => socket.end(`echo:${Buffer.concat(received).toString()}`));
        });

        const tunnel = await open(gym, `/v0/workspaces/${workspaceId}/proxy/websocket`);
        tunnel.send(
            Buffer.from(`CONNECT 127.0.0.1:${String(echo)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`),
        );
        expect(await readUntil(tunnel, (text) => text.endsWith("\r\n\r\n"))).toBe(
            "HTTP/1.1 200 Connection Established\r\n\r\n",
        );
        tunnel.send(Buffer.from("over the tunnel"));
        tunnel.send(new Uint8Array(0));

        const bytes: Buffer[] = [];
        for (;;) {
            const message = await tunnel.next();
            expect(message.binary).toBe(true);
            if (message.data.byteLength === 0) break;
            bytes.push(message.data);
        }
        expect(Buffer.concat(bytes).toString()).toBe("echo:over the tunnel");
        await expect(tunnel.closed).resolves.toMatchObject({ code: 1000 });
    });

    it("opens an agent's and a network's twin in that network", async () => {
        const gym = await started();
        const agentId = gym.defaultSessionId;
        const { workspaceId } = (await gym.client.getAgent(agentId)).agent;
        const { networkId } = await gym.client.getWorkspaceAgentNetwork(workspaceId, agentId);
        const site = await httpFixture((_request, response) => response.end("from the network"));

        for (const path of [
            `/v0/workspaces/${workspaceId}/agents/${agentId}/proxy/websocket`,
            `/v0/networks/${networkId}/proxy/websocket`,
        ]) {
            const tunnel = await open(gym, path);
            tunnel.send(
                Buffer.from(
                    `GET http://127.0.0.1:${String(site)}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
                ),
            );
            expect(await readUntil(tunnel, (text) => text.includes("from the network"))).toMatch(
                /^HTTP\/1\.1 200 /u,
            );
            tunnel.close();
        }
    });

    it("refuses exactly as the CONNECT twin does, before upgrading", async () => {
        const gym = await started();
        const workspaceId = await rootWorkspace(gym);

        await expect(
            open(gym, `/v0/workspaces/${workspaceId}/proxy/websocket`, "wrong-token"),
        ).rejects.toMatchObject({
            status: 401,
            body: { code: "unauthorized", error: expect.any(String) },
        });
        await expect(
            open(gym, "/v0/workspaces/missingworkspace/proxy/websocket"),
        ).rejects.toMatchObject({ status: 404, body: { code: "not_found" } });
        await expect(open(gym, "/v0/networks/r-nowhere/proxy/websocket")).rejects.toMatchObject({
            status: 404,
            body: { code: "not_found" },
        });
        await expect(open(gym, "/v0/artifacts/missing1/proxy/websocket")).rejects.toMatchObject({
            status: 404,
            body: { code: "not_found" },
        });
        await expect(open(gym, "/v0/artifacts/missing1/proxy/websocket")).rejects.toBeInstanceOf(
            BridgeUpgradeError,
        );
    });

    it("pings an idle tunnel at least every 15 seconds", async () => {
        const gym = await started();
        const workspaceId = await rootWorkspace(gym);
        const tunnel = await open(gym, `/v0/workspaces/${workspaceId}/proxy/websocket`);
        const openedAt = Date.now();

        await new Promise<void>((resolve) => tunnel.webSocket.once("ping", () => resolve()));

        expect(Date.now() - openedAt).toBeLessThanOrEqual(16_000);
        expect(tunnel.webSocket.readyState).toBe(tunnel.webSocket.OPEN);
    }, 30_000);

    it("closes on a text message and is not an ordinary route", async () => {
        const gym = await started();
        const workspaceId = await rootWorkspace(gym);
        const tunnel = await open(gym, `/v0/workspaces/${workspaceId}/proxy/websocket`);

        tunnel.send("not bytes");

        await expect(tunnel.closed).resolves.toMatchObject({ code: 1003 });
        const status = await new Promise<number | undefined>((resolve, reject) => {
            request(
                {
                    headers: { authorization: `Bearer ${gym.token}` },
                    path: `/v0/workspaces/${workspaceId}/proxy/websocket`,
                    socketPath: gym.socketPath,
                },
                (response) => {
                    response.resume();
                    resolve(response.statusCode);
                },
            )
                .once("error", reject)
                .end();
        });
        expect(status).toBe(404);
    });
});

async function started(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: [{ content: [{ type: "text", text: "Ready." }] }],
        timeoutMs: 15_000,
    });
    gyms.add(gym);
    return gym;
}

async function rootWorkspace(gym: AgentGym): Promise<string> {
    return (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId;
}

async function open(gym: AgentGym, path: string, token = gym.token): Promise<GymBridgeWebSocket> {
    const tunnel = await connectBridgeWebSocket(new URL(path, "http://agent.local").toString(), {
        socketPath: gym.socketPath,
        token,
    });
    cleanups.push(() => tunnel.close());
    return tunnel;
}

/** Collect the tunnel's bytes as text until `done` says the answer is complete. */
async function readUntil(
    tunnel: GymBridgeWebSocket,
    done: (text: string) => boolean,
): Promise<string> {
    let text = "";
    while (!done(text)) {
        const message = await tunnel.next();
        expect(message.binary).toBe(true);
        text += message.data.toString();
    }
    return text;
}

async function httpFixture(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
    const server = createServer(handler);
    return await listening(server);
}

async function tcpFixture(handler: (socket: Socket) => void): Promise<number> {
    return await listening(createTcpServer({ allowHalfOpen: true }, handler));
}

async function listening(server: Server | ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture port.");
    return address.port;
}
