import { once } from "node:events";
import { createServer, request } from "node:http";
import {
    createServer as createTcpServer,
    type AddressInfo,
    type Server,
    type Socket,
} from "node:net";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("agent networks", () => {
    it("names this computer's network once for every agent here and keeps it past an archive", async () => {
        const gym = await started();
        expect((await gym.client.getHealth()).version.protocol).toBeGreaterThanOrEqual(28);
        const agentId = gym.defaultSessionId;
        const { workspaceId } = (await gym.client.getAgent(agentId)).agent;
        const other = (await gym.client.createAgent({ workspaceId, title: "Second" })).agent.id;
        const bot = (await gym.client.createBot({ name: "Network bot" })).bot;

        const host = await gym.client.getWorkspaceAgentNetwork(workspaceId, agentId);
        expect(host).toEqual({ networkId: "host", kind: "host" });
        expect(await gym.client.getWorkspaceAgentNetwork(workspaceId, other)).toEqual(host);
        expect(await gym.client.getWorkspaceAgentNetwork(bot.workspaceId, bot.agent.id)).toEqual(
            host,
        );

        // The tunnel reaches what this computer serves, with the site's own credentials intact.
        const site = await siteFixture();
        const path = networkPath(gym, host.networkId);
        const tunnel = await attach(gym, path);
        expect(tunnel.status).toBe(200);
        const reply = readAll(tunnel.socket!);
        tunnel.socket!.write(
            `GET http://127.0.0.1:${String(site.port)}/page HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: session=abc\r\nConnection: close\r\n\r\n`,
        );
        expect(await reply).toContain("from the site");
        expect(site.cookies).toEqual(["session=abc"]);

        // The network belongs to this computer, not to the agent that named it.
        const held = await heldFixture();
        const open = await attach(gym, path);
        open.socket!.write(
            `CONNECT 127.0.0.1:${String(held.port)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
        );
        const [answer] = (await once(open.socket!, "data")) as [Buffer];
        expect(answer.toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
        await gym.client.archiveAgent(agentId);
        await expect(
            gym.client.getWorkspaceAgentNetwork(workspaceId, agentId),
        ).rejects.toMatchObject({ status: 409 });
        open.socket!.write("still here");
        await gym.waitUntil(
            async () => (held.received.join("") === "still here" ? true : undefined),
            "the held tunnel to keep carrying bytes",
        );
        expect(open.socket!.destroyed).toBe(false);
        expect((await attach(gym, path)).status).toBe(200);
        expect(gym.errors).toEqual([]);
    });

    it("refuses an unauthenticated, malformed, or unknown network and a misplaced agent", async () => {
        const gym = await started();
        const agentId = gym.defaultSessionId;
        const { workspaceId } = (await gym.client.getAgent(agentId)).agent;
        expect((await attach(gym, networkPath(gym, "host"), "wrong-token")).status).toBe(401);
        for (const networkId of ["Host", "-host", "a".repeat(129), "r-nowhere", "c-gone"])
            expect(await attach(gym, `/v0/networks/${networkId}/proxy`)).toMatchObject({
                status: 404,
                code: "not_found",
            });
        const bot = (await gym.client.createBot({ name: "Elsewhere" })).bot;
        await expect(
            gym.client.getWorkspaceAgentNetwork(bot.workspaceId, agentId),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            gym.client.getWorkspaceAgentNetwork(workspaceId, "missingagent"),
        ).rejects.toMatchObject({ status: 404 });
        expect(gym.machineConnections).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("gives an agent in a container a network of its own, served while its machine is", async () => {
        const gym = await started();
        const { workspaceId: projectId } = (await gym.client.getAgent(gym.defaultSessionId)).agent;
        const project = await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(projectId)).project;
            return current.initialization.status === "ready" ? current : undefined;
        }, "project readiness");
        await gym.client.replaceProjectSettings(
            projectId,
            { defaultWorkspaceCompute: { type: "docker", image: "gym/agent-network:latest" } },
            { ifMatch: project.version },
        );
        const created = await gym.client.createWorkspace({ name: "boxed", parentId: projectId });
        const boxed = await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(created.workspace.id)).workspace;
            if (current.initialization.status === "failed")
                throw new Error(current.initialization.error ?? "workspace failed");
            return current.initialization.status === "ready" ? current : undefined;
        }, "container workspace readiness");
        const first = (await gym.client.createAgent({ workspaceId: boxed.id, title: "One" })).agent;
        const second = (await gym.client.createAgent({ workspaceId: boxed.id, title: "Two" }))
            .agent;

        // Naming the network does not start the container.
        const { networkId, kind } = await gym.client.getWorkspaceAgentNetwork(boxed.id, first.id);
        expect(networkId).toMatch(/^c-[0-9a-f]{32}$/);
        expect(kind).toBe("container");
        const neighbor = (await gym.client.getWorkspaceAgentNetwork(boxed.id, second.id)).networkId;
        expect(neighbor).toMatch(/^c-[0-9a-f]{32}$/);
        expect(neighbor).not.toBe(networkId);
        expect(await gym.client.getWorkspaceAgentNetwork(boxed.id, first.id)).toEqual({
            networkId,
            kind: "container",
        });

        // A restarted daemon builds the same container environment under the same name.
        await gym.restart();
        expect(await gym.client.getWorkspaceAgentNetwork(boxed.id, first.id)).toEqual({
            networkId,
            kind: "container",
        });
        expect((await attach(gym, networkPath(gym, networkId))).status).toBe(200);

        // Archiving the agent withdraws its network, and nothing else answers for it.
        await gym.client.archiveAgent(first.id);
        expect(await attach(gym, networkPath(gym, networkId))).toMatchObject({
            status: 404,
            code: "not_found",
        });
        expect((await gym.client.getWorkspaceAgentNetwork(boxed.id, second.id)).networkId).toBe(
            neighbor,
        );
        expect(gym.machineConnections).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});

async function started(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: [{ content: [{ type: "text", text: "Ready." }] }],
    });
    gyms.add(gym);
    return gym;
}

function networkPath(gym: AgentGym, networkId: string): string {
    return new URL(gym.client.networkProxyUrl(networkId)).pathname;
}

async function listening(server: Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
        async () =>
            await new Promise<void>((resolve) => {
                (server as { closeAllConnections?: () => void }).closeAllConnections?.();
                server.close(() => resolve());
            }),
    );
    return (server.address() as AddressInfo).port;
}

/** A site on this computer's loopback, recording the cookies each request carried. */
async function siteFixture(): Promise<{ port: number; cookies: (string | undefined)[] }> {
    const cookies: (string | undefined)[] = [];
    const port = await listening(
        createServer((incoming, response) => {
            cookies.push(incoming.headers.cookie);
            response.end("from the site");
        }),
    );
    return { port, cookies };
}

/** A TCP service that keeps every connection open and records what arrives. */
async function heldFixture(): Promise<{ port: number; received: string[] }> {
    const sockets: Socket[] = [];
    const received: string[] = [];
    const server = createTcpServer((socket) => {
        socket.on("error", () => undefined);
        socket.on("data", (chunk: Buffer) => received.push(chunk.toString()));
        sockets.push(socket);
    });
    cleanups.push(() => {
        for (const socket of sockets) socket.destroy();
    });
    return { port: await listening(server), received };
}

/** Attach to a proxy route, returning the open tunnel or the status and code it was refused with. */
function attach(
    gym: AgentGym,
    path: string,
    token = gym.token,
): Promise<{ status: number | undefined; code?: string; socket?: Socket }> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.once("error", reject);
        call.once("connect", (response, socket, head) => {
            if (response.statusCode === 200) {
                cleanups.push(() => void socket.destroy());
                if (head.byteLength > 0) socket.unshift(head);
                resolve({ status: 200, socket });
                return;
            }
            let body = head.toString();
            socket.on("data", (chunk: Buffer) => (body += chunk.toString()));
            const done = () => {
                socket.destroy();
                resolve({ status: response.statusCode, ...parse(body) });
            };
            socket.once("end", done);
            socket.once("close", done);
        });
        call.setTimeout(10_000, () => call.destroy(new Error("The proxy did not answer.")));
        call.end();
    });
}

async function readAll(socket: Socket): Promise<string> {
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
    await new Promise<void>((resolve) => {
        socket.once("end", () => resolve());
        socket.once("close", () => resolve());
    });
    return text;
}

function parse(body: string): { code?: string } {
    try {
        const parsed = JSON.parse(body.slice(body.indexOf("{"))) as { code?: unknown };
        return typeof parsed.code === "string" ? { code: parsed.code } : {};
    } catch {
        return {};
    }
}
