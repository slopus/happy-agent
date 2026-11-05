import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAgentDatabaseConnection, type AnyAgentTool } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { McpModule, type McpAuthResult } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
import { presenceMigrations } from "../../sources/presence/PresenceDatabase.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import {
    UserInputModule,
    userInputMigrations,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { startOAuthMcpServer } from "./fixtures/oauthMcpServer.js";

const stdioFixture = fileURLToPath(new URL("./fixtures/stdioServer.mjs", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("logging in to an MCP server", () => {
    it("signs in through a pasted address, shares the login user-wide, and keeps it across restarts", async () => {
        const fixture = await oauthServer();
        const world = await authWorld({
            user: `[mcp_servers.docs]\nurl = "${fixture.url}"\nhttp_headers = { "X-Api-Key" = "configured-secret" }\n`,
            agents: { "agent-a": "folder-a", "agent-b": "folder-b" },
        });
        await world.status("agent-a", "docs", "needs_auth");

        const call = world.startAuth("agent-a", "docs");
        const question = await world.pendingQuestion("agent-a");
        expect(question.permissionRequest).toEqual({
            source: "mcp_elicitation",
            server: "docs",
            serverTitle: "Docs",
        });
        expect(question.context).toContain(
            `The sign-in page is on **${new URL(fixture.origin).host}**.`,
        );
        const link = new URL(signInLink(question));
        expect(link.searchParams.get("code_challenge_method")).toBe("S256");
        expect(link.searchParams.get("resource")).toBe(fixture.url);
        expect(link.searchParams.get("state")?.length).toBeGreaterThanOrEqual(43);
        expect(link.searchParams.get("redirect_uri")).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/callback$/u,
        );
        await world.answer("agent-a", question, fixture.authorize(link.href));

        const result = await call;
        expect(result).toMatchObject({ server: "docs", status: "logged_in" });
        expect(result.message).toContain("every agent that uses your user-wide MCP servers");
        expect(JSON.stringify(result)).not.toMatch(/access-|refresh-|code-|verifier/u);
        await expect(world.echo("agent-a", "docs", "hello")).resolves.toBe("oauth:hello");
        // A user-wide login reaches every agent using the user-wide catalog.
        await world.status("agent-b", "docs", "connected");
        await expect(world.echo("agent-b", "docs", "too")).resolves.toBe("oauth:too");

        // Discovery, registration, and the token request never carried the server's headers.
        expect(fixture.authRequests().length).toBeGreaterThan(0);
        for (const request of fixture.authRequests()) {
            expect(request.headers["x-api-key"], request.path).toBeUndefined();
            expect(request.headers.authorization, request.path).toBeUndefined();
        }
        expect(fixture.mcpRequests().at(-1)?.headers["x-api-key"]).toBe("configured-secret");

        // The next daemon presents the saved login in the background, without asking anyone.
        const registrations = fixture.authRequests().filter((r) => r.path === "/register").length;
        const restarted = await world.restart();
        await restarted.status("agent-a", "docs", "connected");
        await expect(restarted.echo("agent-a", "docs", "back")).resolves.toBe("oauth:back");
        expect(fixture.authRequests().filter((r) => r.path === "/register")).toHaveLength(
            registrations,
        );
        await expect(
            restarted.userInput.list(restarted.ctx, "agent-a", { status: "pending" }),
        ).resolves.toEqual([]);
    });

    it("finishes when the browser lands on this machine's callback", async () => {
        const fixture = await oauthServer();
        const world = await authWorld({
            user: `[mcp_servers.docs]\nurl = "${fixture.url}"\n`,
            agents: { "agent-a": "folder-a" },
        });
        await world.status("agent-a", "docs", "needs_auth");
        const call = world.startAuth("agent-a", "docs");
        const question = await world.pendingQuestion("agent-a");
        const landing = fixture.authorize(signInLink(question));
        // Listening on loopback is optional; the pasted address is the path that always works.
        const reached = await fetch(landing).then(
            (response) => response.ok,
            () => false,
        );
        if (!reached) await world.answer("agent-a", question, landing);

        await expect(call).resolves.toMatchObject({ status: "logged_in" });
        if (reached) {
            await expect(
                world.userInput.list(world.ctx, "agent-a", { status: "terminal" }),
            ).resolves.toMatchObject([
                { status: "cancelled", reason: "Signed in from a browser on this machine." },
            ]);
        }
    });

    it("refuses an address from another sign-in and saves nothing", async () => {
        const fixture = await oauthServer();
        const world = await authWorld({
            user: `[mcp_servers.docs]\nurl = "${fixture.url}"\n`,
            agents: { "agent-a": "folder-a" },
        });
        await world.status("agent-a", "docs", "needs_auth");
        const call = world.startAuth("agent-a", "docs");
        const question = await world.pendingQuestion("agent-a");
        const landing = new URL(fixture.authorize(signInLink(question)));
        landing.searchParams.set("state", "forged-state-from-another-attempt");
        await world.answer("agent-a", question, landing.href);

        const result = await call;
        expect(result.status).toBe("failed");
        expect(result.message).toContain("different sign-in attempt");
        expect(fixture.authRequests().filter((r) => r.path === "/token")).toEqual([]);
        await world.status("agent-a", "docs", "needs_auth");
    });

    it("keeps a folder's login to the agents in that folder", async () => {
        const fixture = await oauthServer();
        const folderToml = `[mcp_servers.docs]\nurl = "${fixture.url}"\n`;
        const world = await authWorld({
            folders: { "folder-a": folderToml, "folder-b": folderToml },
            agents: { "agent-a": "folder-a", "agent-a2": "folder-a", "agent-b": "folder-b" },
        });
        for (const agent of ["agent-a", "agent-a2", "agent-b"]) {
            await world.status(agent, "docs", "needs_auth");
        }
        // Without a login the two folders share one anonymous connection.
        const before = fixture.mcpRequests().length;

        const result = await world.signIn(fixture, "agent-a", "docs");
        expect(result.status).toBe("logged_in");
        expect(result.message).toContain(`every agent working in ${world.folder("folder-a")}`);
        await world.status("agent-a2", "docs", "connected");
        await expect(world.echo("agent-a2", "docs", "shared")).resolves.toBe("oauth:shared");

        await world.status("agent-b", "docs", "needs_auth");
        await expect(world.echo("agent-b", "docs", "elsewhere")).rejects.toThrow(
            'MCP server "docs" needs a login.',
        );
        expect(fixture.mcpRequests().length).toBeGreaterThan(before);
    });

    it("needs a login again once the saved one can no longer be refreshed", async () => {
        const fixture = await oauthServer();
        const world = await authWorld({
            user: `[mcp_servers.docs]\nurl = "${fixture.url}"\n`,
            agents: { "agent-a": "folder-a" },
        });
        await world.status("agent-a", "docs", "needs_auth");
        expect((await world.signIn(fixture, "agent-a", "docs")).status).toBe("logged_in");

        fixture.revokeAll();
        await expect(world.echo("agent-a", "docs", "revoked")).rejects.toThrow();
        await world.status("agent-a", "docs", "needs_auth");
        // A reload checks it again, and with no token left it still needs a login.
        await world.module.reload(world.ctx);
        await world.status("agent-a", "docs", "needs_auth");
        expect((await world.signIn(fixture, "agent-a", "docs")).status).toBe("logged_in");
    });

    it("explains how to log in to a stdio server outside Happy instead of asking", async () => {
        const world = await authWorld({
            user: [
                "[mcp_servers.remote]",
                `command = ${JSON.stringify(process.execPath)}`,
                `args = ${JSON.stringify([stdioFixture, "remote"])}`,
                "",
            ].join("\n"),
            agents: { "agent-a": "folder-a" },
        });
        const result = await world.startAuth("agent-a", "remote");
        expect(result.status).toBe("not_needed");
        expect(result.message).toContain("outside Happy");
        await expect(world.userInput.list(world.ctx, "agent-a")).resolves.toEqual([]);
    });
});

async function oauthServer() {
    const fixture = await startOAuthMcpServer();
    cleanups.push(async () => await fixture.close());
    return fixture;
}

function signInLink(question: UserInputRequest): string {
    const link = /Open this link and sign in: (\S+)/u.exec(question.context)?.[1];
    if (link === undefined) throw new Error("The question has no sign-in link.");
    return link;
}

/**
 * An MCP module on a real database, with agents in folders under one temporary root. `restart`
 * closes the module and starts another on the same database, as the next daemon would.
 */
async function authWorld(options: {
    readonly user?: string;
    readonly folders?: Readonly<Record<string, string>>;
    readonly agents: Readonly<Record<string, string>>;
}) {
    const root = await mkdtemp(join(tmpdir(), "happy-mcp-auth-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const userPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "mcp.toml",
    );
    await mkdir(dirname(userPath), { recursive: true });
    await writeFile(userPath, options.user ?? "", "utf8");
    const folder = (name: string) => join(root, name);
    for (const name of new Set(Object.values(options.agents))) {
        await mkdir(folder(name), { recursive: true });
        const toml = options.folders?.[name];
        if (toml !== undefined) await writeFile(join(folder(name), "mcp.toml"), toml, "utf8");
    }
    const config = await ConfigModule.load(join(root, ".happy"));
    const agents = {
        config: async (_ctx: unknown, agentId: string) => {
            const name = options.agents[agentId];
            return name === undefined
                ? undefined
                : {
                      environment: {
                          osVersion: "test",
                          platform: process.platform,
                          shell: "",
                          workingDirectory: folder(name),
                      },
                  };
        },
        parentOf: async () => null,
    } as never;
    const migrations = new McpModule(
        config,
        new UserInputModule(new PresenceModule(config)),
        { onEvent: () => () => undefined } as never,
        new RunnersModule(config),
        new ComputeModule(config, new SecretsModule(), new RunnersModule(config)),
    ).migrations;
    const db = moduleDatabase(
        [...presenceMigrations, ...userInputMigrations, ...migrations],
        "mcp-auth",
    );
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    cleanups.push(() => db.close());

    async function start() {
        const ctx = db.context;
        const presence = new PresenceModule(config);
        const userInput = new UserInputModule(presence);
        const runners = new RunnersModule(config);
        const module = new McpModule(
            config,
            userInput,
            { onEvent: () => () => undefined } as never,
            runners,
            new ComputeModule(config, new SecretsModule(), runners),
        );
        cleanups.push(async () => await module.close());
        userInput.beforeStart(ctx, agents);
        const hooks = await resolveModuleHooks(ctx, module, agents);
        for (const agentId of Object.keys(options.agents)) {
            await hooks.agentRestored?.(
                ctx,
                { agents, sharedKV: {} } as never,
                {
                    id: agentId,
                    metadata: undefined,
                } as never,
            );
        }
        const tool = async (agentId: string): Promise<AnyAgentTool> => {
            const found = (
                await hooks.tools!(ctx, { agent: { id: agentId, permissionMode: "auto" } } as never)
            ).find((candidate) => candidate.name === "start_mcp_auth");
            if (found === undefined) throw new Error("start_mcp_auth is not installed.");
            return found;
        };
        const world = {
            ctx,
            module,
            userInput,
            folder,
            async status(agentId: string, server: string, status: string): Promise<void> {
                await expect
                    .poll(
                        async () =>
                            (await module.listServerPage(ctx, agentId)).servers.find(
                                (entry) => entry.name === server,
                            )?.status,
                        { timeout: 10_000 },
                    )
                    .toBe(status);
            },
            async startAuth(agentId: string, server: string): Promise<McpAuthResult> {
                return (await (
                    await tool(agentId)
                ).execute(ctx, { server }, undefined as never)) as McpAuthResult;
            },
            async pendingQuestion(agentId: string): Promise<UserInputRequest> {
                let found: UserInputRequest | undefined;
                await expect
                    .poll(async () => {
                        found = (await userInput.list(ctx, agentId, { status: "pending" }))[0];
                        return found !== undefined;
                    })
                    .toBe(true);
                return found!;
            },
            async answer(agentId: string, question: UserInputRequest, address: string) {
                await userInput.answer(ctx, agentId, {
                    requestId: question.id,
                    answers: { address },
                });
            },
            async signIn(
                fixture: Awaited<ReturnType<typeof oauthServer>>,
                agentId: string,
                server: string,
            ): Promise<McpAuthResult> {
                const call = world.startAuth(agentId, server);
                const question = await world.pendingQuestion(agentId);
                await world.answer(agentId, question, fixture.authorize(signInLink(question)));
                return await call;
            },
            async echo(agentId: string, server: string, text: string): Promise<string> {
                const result = await module.callTool(ctx, agentId, {
                    server,
                    name: "echo",
                    arguments: { text },
                });
                const first = result.content?.[0];
                if (first?.type !== "text") throw new Error("The server returned no text.");
                return first.text;
            },
            async restart() {
                await module.close();
                return await start();
            },
        };
        return world;
    }
    return await start();
}
