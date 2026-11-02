import {
    createServer,
    request,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const gyms = new Set<AgentGym>();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("server connections by URL", () => {
    it("is added by the Chief of Staff and reached only with the app's own token", async () => {
        const f = await started();
        const server = await teamServer();

        const added = JSON.parse(await command(f, "add_server_connection", { url: server.url }));
        expect(added.connections).toEqual([
            {
                id: "localhost",
                name: "localhost",
                orderKey: expect.any(String) as string,
                authentication: "oauth",
                url: `${server.url}/`,
            },
        ]);
        await f.gym.waitForEvent(
            (event) =>
                event.type === "connections.updated" &&
                event.payload.connections.some((connection) => connection.id === "localhost"),
            "the roster with the new server",
        );

        // An agent's request, or any other without the person's token, never reaches the server.
        const anonymous = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/health");
        expect(anonymous.status).toBe(403);
        expect(JSON.parse(anonymous.body)).toMatchObject({ code: "remote_sign_in_required" });
        expect(server.requests).toEqual([]);

        const health = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/health", {
            "happy-remote-authorization": "Bearer access-1",
        });
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toMatchObject({ instanceId: INSTANCE });
        // The server sees the person's token as its own credential, and nothing of the daemon's.
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({ authorization: "Bearer access-1" });
        expect(server.requests[0]).not.toHaveProperty("happy-remote-authorization");

        // The relayed health teaches the roster the server's identity.
        await f.gym.waitUntil(
            async () =>
                (await f.gym.client.listConnections()).connections.find(
                    (connection) => connection.instanceId === INSTANCE,
                ),
            "the roster to learn the server's identity",
        );
        expect(f.gym.errors).toEqual([]);
    }, 30_000);

    it("refuses addresses that are not Happy servers offering single sign-on", async () => {
        const f = await started();
        const server = await teamServer();

        expect(
            await command(f, "add_server_connection", { url: "http://happy.example.com" }),
        ).toMatch(/https:\/\//u);
        server.edge = "redirect";
        expect(await command(f, "add_server_connection", { url: server.url })).toMatch(
            /not a Happy server/u,
        );
        server.edge = "none";
        server.offersOAuth = false;
        expect(await command(f, "add_server_connection", { url: server.url })).toMatch(
            /does not offer a sign-in/u,
        );
        server.offersOAuth = true;
        await command(f, "add_server_connection", { url: server.url });
        expect(await command(f, "add_server_connection", { url: `${server.url}/` })).toMatch(
            /already connected as localhost/u,
        );
        expect((await f.gym.client.listConnections()).connections).toHaveLength(1);
    }, 30_000);

    it("answers an edge redirect as a sign-in for that server, never as a redirect", async () => {
        const f = await started();
        const server = await teamServer();
        await command(f, "add_server_connection", { url: server.url });

        server.edge = "redirect";
        const proxied = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/health", {
            "happy-remote-authorization": "Bearer access-1",
        });
        expect(proxied.status).toBe(403);
        expect(proxied.location).toBeUndefined();
        expect(JSON.parse(proxied.body)).toMatchObject({ code: "remote_sign_in_required" });
    }, 30_000);

    it("passes a Happy 403 and the profile gate through, and turns an expired token into a sign-in", async () => {
        const f = await started();
        const server = await teamServer();
        await command(f, "add_server_connection", { url: server.url });
        const remote = { "happy-remote-authorization": "Bearer access-1" };

        const refused = await rawRequest(
            f.gym,
            "/v0/connections/localhost/api/v0/forbidden",
            remote,
        );
        expect(refused.status).toBe(403);
        expect(JSON.parse(refused.body)).toEqual({ error: "Not yours.", code: "forbidden" });
        // The token still works, so a Happy 401 is the remote's profile gate.
        const gated = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/gated", remote);
        expect(gated.status).toBe(401);
        expect(JSON.parse(gated.body)).toEqual({ error: "Save a profile.", code: "unauthorized" });

        const expired = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/health", {
            "happy-remote-authorization": "Bearer expired",
        });
        expect(expired.status).toBe(403);
        expect(JSON.parse(expired.body)).toMatchObject({ code: "remote_sign_in_required" });
    }, 30_000);

    it("carries a CONNECT tunnel over the server's WebSocket twin with the app's token", async () => {
        const f = await started();
        const server = await teamServer();
        await command(f, "add_server_connection", { url: server.url });

        expect(await tunnel(f.gym, {})).toBe("refused:403");
        expect(await tunnel(f.gym, { "happy-remote-authorization": "Bearer access-1" })).toBe(
            "echo:hello",
        );
        expect(server.tunnelAuthorizations).toEqual(["Bearer access-1"]);
    }, 30_000);

    it("is removed like any other connection", async () => {
        const f = await started();
        const server = await teamServer();
        await command(f, "add_server_connection", { url: server.url });

        const removed = JSON.parse(
            await command(f, "remove_remote_connection", { id: "localhost" }),
        );
        expect(removed.connections).toEqual([]);
        const proxied = await rawRequest(f.gym, "/v0/connections/localhost/api/v0/health", {
            "happy-remote-authorization": "Bearer access-1",
        });
        expect(proxied.status).toBe(404);
    }, 30_000);
});

interface Fixture {
    gym: AgentGym;
    commands: { name: string; arguments: Record<string, unknown> }[];
    chiefId: string;
}

async function started(): Promise<Fixture> {
    const commands: Fixture["commands"] = [];
    const gym = await createAgentGym({
        permissionMode: "full_access",
        timeoutMs: 15_000,
        inference: (request) => {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "Team server" }] };
            const next = commands.shift();
            return next === undefined
                ? { content: [{ type: "text", text: "Done." }] }
                : { content: [{ type: "tool_call", ...next }] };
        },
    });
    gyms.add(gym);
    const chief = (await gym.client.listBots()).bots.find(
        (bot) => bot.isAdmin && bot.status === "active",
    );
    if (chief === undefined) throw new Error("The gym has no Chief of Staff.");
    return { gym, commands, chiefId: chief.agent.id };
}

/** Have the Chief of Staff call one tool, as when the person asks it to; returns the result text. */
async function command(f: Fixture, name: string, args: Record<string, unknown>): Promise<string> {
    f.commands.push({ name, arguments: args });
    await f.gym.send(`Use ${name} as I asked.`, {
        sessionId: f.chiefId,
        permissionMode: "full_access",
    });
    return f.gym.inference.toolResults().at(-1)!.text;
}

interface TeamServer {
    url: string;
    edge: "none" | "redirect";
    offersOAuth: boolean;
    /** Headers of the authenticated requests that reached the server. */
    readonly requests: IncomingHttpHeaders[];
    readonly tunnelAuthorizations: (string | undefined)[];
}

/** A team server behind an SSO edge; `access-<n>` tokens are valid and anything else is not. */
async function teamServer(): Promise<TeamServer> {
    const state: TeamServer = {
        url: "",
        edge: "none",
        offersOAuth: true,
        requests: [],
        tunnelAuthorizations: [],
    };
    const tunnels = new WebSocketServer({ noServer: true });
    const json = (response: ServerResponse, status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    };
    const valid = (authorization: string | undefined) =>
        authorization !== undefined && /^Bearer access-\d+$/u.test(authorization);
    const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
        const path = (incoming.url ?? "/").split("?")[0];
        const authorization = incoming.headers.authorization;
        if (state.edge === "redirect") {
            response.writeHead(302, { location: "https://sso.example.com/login" });
            response.end();
            return;
        }
        if (path === "/v0/authentication") {
            json(response, 200, {
                authenticated: valid(authorization),
                userId: valid(authorization) ? "user1" : null,
                methods: state.offersOAuth
                    ? [
                          {
                              type: "oauth",
                              id: "jwt",
                              name: "Example",
                              authorizationUrl: "https://sso.example.com/authorize",
                              tokenUrl: "https://sso.example.com/token",
                              clientId: "happy",
                          },
                      ]
                    : [],
            });
            return;
        }
        if (!valid(authorization)) {
            json(response, 401, { error: "Unauthorized", code: "unauthorized" });
            return;
        }
        state.requests.push(incoming.headers);
        if (path === "/v0/health") {
            json(response, 200, {
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 22, daemon: "team" },
                instanceId: INSTANCE,
                capabilities: { webSocketTunnels: true },
            });
            return;
        }
        if (path === "/v0/gated") {
            json(response, 401, { error: "Save a profile.", code: "unauthorized" });
            return;
        }
        if (path === "/v0/forbidden") {
            json(response, 403, { error: "Not yours.", code: "forbidden" });
            return;
        }
        json(response, 404, { error: "Not found.", code: "not_found" });
    });
    server.on("upgrade", (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
        state.tunnelAuthorizations.push(incoming.headers.authorization);
        if (
            incoming.url !== "/v0/workspaces/w1/proxy/websocket" ||
            !valid(incoming.headers.authorization)
        ) {
            socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
            return;
        }
        tunnels.handleUpgrade(incoming, socket, head, (webSocket) => {
            webSocket.on("message", (data: Buffer) => {
                if (data.length > 0) webSocket.send(Buffer.from(`echo:${data.toString()}`));
            });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                for (const client of tunnels.clients) client.terminate();
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture port.");
    state.url = `http://localhost:${String(address.port)}`;
    return state;
}

async function rawRequest(
    gym: AgentGym,
    path: string,
    headers: Record<string, string> = {},
): Promise<{ status: number | undefined; location: string | undefined; body: string }> {
    return await new Promise((resolve, reject) => {
        request(
            {
                headers: { authorization: `Bearer ${gym.token}`, ...headers },
                path,
                socketPath: gym.socketPath,
            },
            (response) => {
                let body = "";
                response.on("data", (chunk: Buffer) => (body += chunk.toString()));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode,
                        location: response.headers.location,
                        body,
                    }),
                );
            },
        )
            .once("error", reject)
            .end();
    });
}

/** Open a workspace CONNECT tunnel through the connection, send `hello`, and read the reply. */
async function tunnel(gym: AgentGym, headers: Record<string, string>): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const connect = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path: "/v0/connections/localhost/api/v0/workspaces/w1/proxy",
            headers: { authorization: `Bearer ${gym.token}`, host: "example.test:80", ...headers },
        });
        connect.once("error", reject);
        connect.once("response", (response) => {
            resolve(`refused:${String(response.statusCode)}`);
            response.resume();
        });
        connect.once("connect", (response, socket: Socket) => {
            if (response.statusCode !== 200) {
                resolve(`refused:${String(response.statusCode)}`);
                socket.destroy();
                return;
            }
            socket.write("hello");
            socket.once("data", (data: Buffer) => {
                resolve(data.toString());
                socket.destroy();
            });
        });
        connect.end();
    });
}
