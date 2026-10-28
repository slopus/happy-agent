import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    AgentProviders,
    withAgentDatabase,
    type AgentModuleHooks,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { HappyAgentClient, type HappyAgentEvent } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { TeammateNotFoundError } from "../../sources/teammates/index.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
});

describe("looping in a teammate", () => {
    it("seeds the configured members, owner included, and starts opted-out members out of new tasks", async () => {
        const { runtime, endpoint, token } = await start();
        const ctx = withAgentDatabase(runtime.ctx.named("test.teammates-seed"), runtime.database);
        const { team, tasks, teammates, userSettings } = runtime.modules;

        expect(await teammates.list(ctx)).toEqual([
            {
                id: expect.any(String),
                name: "Alice Owner",
                role: "Founder",
                follows: null,
            },
            {
                id: expect.any(String),
                name: "Steve",
                role: "Billing engineer",
                follows: "Billing, invoices, and Stripe webhooks",
            },
        ]);
        const [alice, steve] = await teammates.list(ctx);
        expect((await team.getUser(ctx, alice!.id))?.isOwner).toBe(true);
        const steveUser = (await team.getUser(ctx, steve!.id))!;
        expect(steveUser.email).toBe("steve@acme.example");
        expect(
            (await userSettings.get(team.connectionContext(ctx, steveUser), "tasks.autoJoin"))
                .value,
        ).toBe(false);

        const task = await tasks.create(ctx, { name: "Refund flow", ownerUserId: alice!.id });
        expect(await tasks.membership(ctx, task.id, alice!.id)).toBeDefined();
        expect(await tasks.membership(ctx, task.id, steve!.id)).toBeUndefined();

        // Signing in finds the seeded profile, with what the machine configuration said.
        const steveClient = new HappyAgentClient({ endpoint, token: await token("user_steve") });
        const { profile } = await steveClient.getProfile();
        expect(profile).toMatchObject({
            userId: steve!.id,
            name: "Steve",
            role: "Billing engineer",
            follows: "Billing, invoices, and Stripe webhooks",
        });
        const edited = await steveClient.updateProfile(
            { role: "Payments lead", follows: null },
            { ifMatch: profile.version },
        );
        expect(edited.profile).toMatchObject({ role: "Payments lead", follows: null });
        const [listed] = (await steveClient.getUsers([steve!.id])).users;
        expect(listed).toMatchObject({ role: "Payments lead", follows: null });
        await expect(
            steveClient.updateProfile(
                { role: " " },
                {
                    ifMatch: edited.profile.version,
                },
            ),
        ).rejects.toMatchObject({ status: 400 });
    }, 60_000);

    it("lets a task's agent loop a teammate in as unread on their connections, and clears it when they read it", async () => {
        const { runtime, endpoint, token } = await start();
        const ctx = withAgentDatabase(
            runtime.ctx.named("test.teammates-loop-in"),
            runtime.database,
        );
        const { tasks, teammates, team } = runtime.modules;
        const [alice, steve] = await teammates.list(ctx);
        const steveClient = new HappyAgentClient({ endpoint, token: await token("user_steve") });
        const aliceClient = new HappyAgentClient({ endpoint, token: await token("user_alice") });
        const task = await tasks.create(ctx, { name: "Refund flow", ownerUserId: alice!.id });
        const before = {
            alice: (await aliceClient.getEvents()).latestCursor,
            steve: (await steveClient.getEvents()).latestCursor,
        };

        // Only a task's own agent gets the tools, and only in team mode.
        // The runtime wraps every module's hooks; ask for them the way the agent system does.
        const beforeStart = teammates.beforeStart as unknown as (
            ctx: Context,
            agents: undefined,
        ) => Promise<AgentModuleHooks>;
        const hooks = await beforeStart(ctx, undefined);
        const scope = (agentId: string) => ({ agent: { id: agentId } }) as AgentModuleScope;
        expect(await hooks.tools!(ctx, scope("someotheragent"))).toEqual([]);
        expect(await hooks.instructions!(ctx, scope("someotheragent"))).toBe("");
        const tools = await hooks.tools!(ctx, scope(task.agentId));
        expect(tools.map((tool) => tool.name)).toEqual(["list_teammates", "loop_in_teammate"]);
        expect(await hooks.instructions!(ctx, scope(task.agentId))).toContain(
            '<happy-user id="…"/>',
        );
        const loopIn = tools.find((tool) => tool.name === "loop_in_teammate")!;
        expect(loopIn.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);

        const looped = await loopIn.execute(
            ctx,
            { userId: steve!.id, reason: "This changes how refunds hit Stripe." },
            {} as never,
        );
        expect(looped).toEqual({
            userId: steve!.id,
            name: "Steve",
            joined: true,
            mention: `<happy-user id="${steve!.id}"/>`,
        });

        // Steve's own views carry the mark; nobody else's do.
        const unread = {
            reason: "looped_in",
            since: expect.any(Number),
            agentId: task.agentId,
            note: "This changes how refunds hit Stripe.",
        };
        expect((await steveClient.getTask(task.id)).membership).toMatchObject({ unread });
        expect((await steveClient.listTasks({ scope: "joined" })).memberships).toMatchObject([
            { taskId: task.id, unread },
        ]);
        expect((await steveClient.getDesktopBootstrap()).taskMemberships).toMatchObject([
            { taskId: task.id, unread },
        ]);
        expect((await aliceClient.getTask(task.id)).membership).toMatchObject({ unread: null });

        // Reading clears it, once, and only Steve hears about it.
        const read = await post(endpoint, await token("user_steve"), `/v0/tasks/${task.id}/read`);
        expect(read.status).toBe(200);
        expect(((await read.json()) as { membership: unknown }).membership).toMatchObject({
            taskId: task.id,
            unread: null,
        });
        expect(
            (await post(endpoint, await token("user_steve"), `/v0/tasks/${task.id}/read`)).status,
        ).toBe(200);
        const events = async (client: HappyAgentClient, after: string) =>
            (await client.getEvents({ after })).events
                .filter((event: HappyAgentEvent) => event.type.startsWith("task."))
                .map((event: HappyAgentEvent) => ({
                    type: event.type,
                    unread: (event.payload as { membership?: { unread?: unknown } }).membership
                        ?.unread,
                }));
        expect(await events(steveClient, before.steve)).toEqual([
            { type: "task.joined", unread },
            { type: "task.membership.updated", unread: null },
        ]);
        expect((await events(aliceClient, before.alice)).map((event) => event.type)).not.toContain(
            "task.membership.updated",
        );

        // Marking the task's chat read clears a loop-in mark too.
        await teammates.loopIn(ctx, {
            taskId: task.id,
            agentId: task.agentId,
            userId: steve!.id,
            reason: "One more look, please.",
        });
        expect((await steveClient.getTask(task.id)).membership).toMatchObject({
            unread: { note: "One more look, please." },
        });
        await steveClient.markAgentRead(task.agentId);
        expect((await steveClient.getTask(task.id)).membership).toMatchObject({ unread: null });

        // Unknown people and guests cannot be looped in, and archived tasks take nobody new.
        const guest = await team.createGuest(ctx, { name: "Exported bot guest" });
        for (const userId of ["nosuchuser1234", guest.id]) {
            await expect(
                teammates.loopIn(ctx, {
                    taskId: task.id,
                    agentId: task.agentId,
                    userId,
                    reason: "Just because.",
                }),
            ).rejects.toBeInstanceOf(TeammateNotFoundError);
        }
        const current = (await tasks.get(ctx, task.id))!;
        await tasks.archive(ctx, task.id, current.version);
        await expect(
            teammates.loopIn(ctx, {
                taskId: task.id,
                agentId: task.agentId,
                userId: alice!.id,
                reason: "Too late.",
            }),
        ).rejects.toMatchObject({ name: "TaskConflictError" });
    }, 60_000);
});

async function post(endpoint: string, token: string, path: string): Promise<Response> {
    return await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
    });
}

async function start(): Promise<{
    runtime: HappyAgentRuntime;
    endpoint: string;
    token: (subject: string) => Promise<string>;
}> {
    const root = await mkdtemp(join(tmpdir(), "teammates-api-"));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    const happyHome = join(root, ".happy");
    const configPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "happy.toml",
    );
    await mkdir(dirname(configPath), { recursive: true });
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    await writeFile(
        configPath,
        [
            "[feature.team]",
            "enabled = true",
            'host = "127.0.0.1"',
            "port = 0",
            'workos_organization_id = "org_teammates"',
            'owner_workos_user_id = "user_alice"',
            "",
            "[feature.team.members.user_alice]",
            'name = "Alice Owner"',
            'role = "Founder"',
            "",
            "[feature.team.members.user_steve]",
            'name = "Steve"',
            'email = "steve@acme.example"',
            'role = "Billing engineer"',
            'follows = "Billing, invoices, and Stripe webhooks"',
            "auto_join_tasks = false",
        ].join("\n"),
    );
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "teammates", use: "sig" };
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("api.workos.com/sso/jwks/")
            ? Promise.resolve(Response.json({ keys: [jwk] }))
            : nativeFetch(input, init),
    );
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider([]), "codex");
    let server: Server | undefined;
    let endpoint = "";
    const runtime = await startHappyAgentRuntime({
        happyHome,
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
        onPrepared: async (prepared) => {
            server = createServer((request, response) => {
                void prepared.api.handleRequest(prepared.context("test.http"), request, response);
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing address.");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
    });
    cleanups.push(async () => {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await runtime.close();
    });
    return {
        runtime,
        endpoint,
        token: async (subject) =>
            await new SignJWT({
                client_id: clientId,
                org_id: "org_teammates",
                sid: "session_teammates",
            })
                .setProtectedHeader({ alg: "RS256", kid: "teammates" })
                .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey),
    };
}
