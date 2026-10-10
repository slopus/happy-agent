import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient, type HappyAgentEvent } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const PNG = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
});

describe("the task API", () => {
    it("lists, orders, and archives a standalone person's tasks without a user ID", async () => {
        const { runtime, endpoint } = await start(false);
        const token = (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim();
        const client = new HappyAgentClient({ endpoint, token });
        const ctx = withAgentDatabase(runtime.ctx.named("test.tasks"), runtime.database);
        const before = (await client.getEvents()).latestCursor;

        const first = await runtime.modules.tasks.create(ctx, { name: "Fix login" });
        const second = await runtime.modules.tasks.create(ctx, { name: "Write docs" });

        const all = await client.listTasks();
        expect(all.tasks.map((task) => task.id)).toEqual([first.id, second.id]);
        expect(all.tasks[0]).toMatchObject({
            name: "Fix login",
            ownerUserId: null,
            creatorAgentId: null,
            status: "active",
            canArchive: true,
            agent: { id: first.agentId, workspaceId: first.workspaceId, userVisible: true },
        });
        // The one person joins every task created on their installation, newest on top.
        expect(all.memberships.map((membership) => [membership.taskId, membership.userId])).toEqual(
            [
                [second.id, null],
                [first.id, null],
            ],
        );
        const joined = await client.listTasks({ scope: "joined" });
        expect(joined.tasks.map((task) => task.id)).toEqual([second.id, first.id]);

        const moved = await client.reorderTask(first.id, { afterId: null, mutationId: "move" });
        expect(moved.membership?.userId).toBeNull();
        const bootstrap = await client.getDesktopBootstrap();
        expect(bootstrap.tasks?.map((task) => task.id)).toEqual([first.id, second.id]);
        expect(bootstrap.tasks?.every((task) => task.canArchive === true)).toBe(true);
        expect(bootstrap.taskMemberships?.map((membership) => membership.taskId)).toEqual([
            first.id,
            second.id,
        ]);

        const archived = await client.archiveTask(first.id, {
            ifMatch: moved.task.version,
            mutationId: "archive",
        });
        expect(archived.task).toMatchObject({ status: "archived", canArchive: true });
        expect(archived.task.archivedAt).not.toBeNull();
        expect(archived.task.agent.canSendMessages).toBe(false);
        // Archival keeps the task in the person's list.
        expect(archived.membership?.taskId).toBe(first.id);
        const restored = await client.unarchiveTask(first.id, { ifMatch: archived.task.version });
        expect(restored.task).toMatchObject({ status: "active", archivedAt: null });

        const events = (await client.getEvents({ after: before })).events.filter((event) =>
            event.type.startsWith("task."),
        );
        expect(events.map((event) => event.type)).toEqual([
            "task.created",
            "task.joined",
            "task.created",
            "task.joined",
            "task.reordered",
            "task.updated",
            "task.updated",
        ]);
        // Events reach every member alike, so they never carry the caller-relative flag.
        expect(events[0]?.payload).not.toHaveProperty("task.canArchive");
        expect(events[4]?.payload).toMatchObject({ mutationId: "move" });
        expect(events[5]?.payload).toMatchObject({
            taskId: first.id,
            mutationId: "archive",
            changes: { status: "archived" },
        });
    }, 30_000);

    it("keeps each team member's list private and lets only owners archive", async () => {
        const { runtime, endpoint, token } = await start(true);
        const [alice, bob, carol] = await Promise.all(
            ["user_alice", "user_bob", "user_carol"].map(
                async (subject) => new HappyAgentClient({ endpoint, token: await token(subject) }),
            ),
        );
        const ids: string[] = [];
        for (const [client, name] of [
            [alice, "Alice"],
            [bob, "Bob"],
            [carol, "Carol"],
        ] as const) {
            const { profile } = await client!.getProfile();
            const saved = await client!.updateProfile({ name }, { ifMatch: profile.version });
            ids.push(saved.profile.userId!);
        }
        const [, bobId, carolId] = ids as [string, string, string];
        const ctx = withAgentDatabase(runtime.ctx.named("test.tasks"), runtime.database);
        const before = (await alice!.getEvents()).latestCursor;

        const login = await runtime.modules.tasks.create(ctx, {
            name: "Fix login",
            ownerUserId: bobId,
        });
        const orphan = await runtime.modules.tasks.create(ctx, { name: "Nobody's task" });
        const docs = await runtime.modules.tasks.create(ctx, {
            name: "Write docs",
            ownerUserId: bobId,
        });

        // Everyone sees every task; who may archive depends on who is asking.
        const archivable = async (client: HappyAgentClient) =>
            (await client.listTasks()).tasks.map((task) => [task.id, task.canArchive]);
        expect(await archivable(bob!)).toEqual([
            [login.id, true],
            [orphan.id, false],
            [docs.id, true],
        ]);
        expect(await archivable(carol!)).toEqual([
            [login.id, false],
            [orphan.id, false],
            [docs.id, false],
        ]);
        // The team owner may archive every task.
        expect(await archivable(alice!)).toEqual([
            [login.id, true],
            [orphan.id, true],
            [docs.id, true],
        ]);
        expect((await bob!.listTasks()).tasks[0]?.ownerUserId).toBe(bobId);

        // The owner joined both of their tasks; nobody else joined anything.
        const order = async (client: HappyAgentClient) =>
            (await client.listTasks({ scope: "joined" })).tasks.map((task) => task.id);
        expect(await order(bob!)).toEqual([docs.id, login.id]);
        expect(await order(carol!)).toEqual([]);

        const carolJoined = await carol!.joinTask(login.id, { mutationId: "carol-join" });
        expect(carolJoined.membership).toMatchObject({ taskId: login.id, userId: carolId });
        expect((await carol!.joinTask(login.id)).membership).toEqual(carolJoined.membership);
        await bob!.reorderTask(login.id, { afterId: null });
        expect(await order(bob!)).toEqual([login.id, docs.id]);
        expect(await order(carol!)).toEqual([login.id]);
        expect((await carol!.getTask(docs.id)).membership).toBeNull();
        await expect(carol!.reorderTask(docs.id, { afterId: null })).rejects.toMatchObject({
            status: 409,
        });

        const bootstrap = await carol!.getDesktopBootstrap();
        expect(bootstrap.tasks?.map((task) => task.id)).toEqual([login.id, orphan.id, docs.id]);
        expect(bootstrap.taskMemberships).toEqual([carolJoined.membership]);

        // A member who does not own a task cannot archive it, whatever version they hold.
        const current = (await carol!.getTask(login.id)).task;
        await expect(
            carol!.archiveTask(login.id, { ifMatch: current.version }),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
        await expect(
            bob!.archiveTask(orphan.id, { ifMatch: (await bob!.getTask(orphan.id)).task.version }),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
        const archived = await bob!.archiveTask(login.id, { ifMatch: current.version });
        expect(archived.task.status).toBe("archived");
        await expect(
            bob!.unarchiveTask(login.id, { ifMatch: current.version }),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
            carol!.unarchiveTask(login.id, { ifMatch: archived.task.version }),
        ).rejects.toMatchObject({ status: 403 });
        const restored = await alice!.unarchiveTask(login.id, { ifMatch: archived.task.version });
        expect(restored.task.status).toBe("active");
        const orphanArchived = await alice!.archiveTask(orphan.id, {
            ifMatch: (await alice!.getTask(orphan.id)).task.version,
        });
        expect(orphanArchived.task.status).toBe("archived");

        // Leaving never archives: not when the owner leaves, nor when the last member does.
        const ownerLeft = await bob!.leaveTask(login.id);
        expect(ownerLeft).toMatchObject({
            membership: null,
            task: { status: "active", ownerUserId: bobId },
        });
        expect(await order(carol!)).toEqual([login.id]);
        const lastLeft = await carol!.leaveTask(login.id, { mutationId: "carol-leave" });
        expect(lastLeft.task.status).toBe("active");
        expect((await carol!.leaveTask(login.id)).membership).toBeNull();
        expect((await alice!.getTask(login.id)).task.status).toBe("active");

        // Membership events reach only the member; task events reach everyone.
        const types = async (client: HappyAgentClient) =>
            (await client.getEvents({ after: before })).events
                .filter((event: HappyAgentEvent) => event.type.startsWith("task."))
                .map((event: HappyAgentEvent) => event.type);
        expect(await types(carol!)).toEqual([
            "task.created",
            "task.created",
            "task.created",
            "task.joined",
            "task.updated",
            "task.updated",
            "task.updated",
            "task.left",
        ]);
        expect(await types(bob!)).toEqual([
            "task.created",
            "task.joined",
            "task.created",
            "task.created",
            "task.joined",
            "task.reordered",
            "task.updated",
            "task.updated",
            "task.updated",
            "task.left",
        ]);
        const carolEvents = (await carol!.getEvents({ after: before })).events;
        expect(carolEvents.find((event) => event.type === "task.left")?.payload).toEqual({
            membership: { ...carolJoined.membership, userId: carolId },
            mutationId: "carol-leave",
        });

        // The task's agent is an ordinary agent whose lifecycle belongs to the task.
        const { agent } = await carol!.getAgent(login.agentId);
        expect(agent).toMatchObject({
            workspaceId: login.workspaceId,
            userVisible: true,
            managedByAnotherAgent: false,
            orderKey: null,
        });
        await expect(carol!.archiveAgent(login.agentId, {})).rejects.toMatchObject({
            status: 409,
        });
        await expect(carol!.getWorkspace(login.workspaceId)).rejects.toMatchObject({
            status: 404,
        });

        // A client shows the owner's photo through the users routes.
        const { profile } = await bob!.getProfile();
        await bob!.setProfilePhoto(
            { contentType: "image/png", data: PNG },
            {
                ifMatch: profile.version,
            },
        );
        const [owner] = (await carol!.getUsers([bobId])).users;
        expect(owner?.photo?.thumbhash).toEqual(expect.any(String));
        const photo = await carol!.getUserPhoto(bobId);
        // The same normalized image the owner sees as their own profile photo.
        expect(photo).toEqual(await bob!.getProfilePhoto());
        expect(photo?.data.byteLength).toBeGreaterThan(0);
        await expect(carol!.getUserPhoto(carolId)).rejects.toMatchObject({ status: 404 });
    }, 60_000);
});

async function start(team: boolean): Promise<{
    runtime: HappyAgentRuntime;
    endpoint: string;
    token: (subject: string) => Promise<string>;
}> {
    const root = await mkdtemp(join(tmpdir(), "task-api-"));
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
    if (team) {
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                'workos_organization_id = "org_tasks"',
                'owner_workos_user_id = "user_alice"',
            ].join("\n"),
        );
        const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "tasks", use: "sig" };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
            String(input).includes("api.workos.com/sso/jwks/")
                ? Promise.resolve(Response.json({ keys: [jwk] }))
                : nativeFetch(input, init),
        );
    }
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
            await new SignJWT({ client_id: clientId, org_id: "org_tasks", sid: "session_tasks" })
                .setProtectedHeader({ alg: "RS256", kid: "tasks" })
                .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey),
    };
}
