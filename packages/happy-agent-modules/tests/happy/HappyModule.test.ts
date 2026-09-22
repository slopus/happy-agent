import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentConfig, AgentPermissionMode } from "@slopus/happy-agent-base";
import { ensureAgentDatabaseConnection, inTx } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createHappySyncDatabase,
    HappyModule,
    happyProjectSyncMigrations,
    happySyncMigrations,
    type HappySpawnRequest,
} from "../../sources/happy/index.js";
import { happyIntegrationMigrations } from "../../sources/happy/HappyIntegrationDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import type { BotRecord } from "../../sources/bots/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { ProjectFileError } from "../../sources/files/index.js";

const happyConnection = vi.hoisted(() => ({
    configuration: {
        credentials: {
            encryption: { secret: new Uint8Array(32), type: "legacy" as const },
            token: "token",
        },
        credentialsPath: "/tmp/happy/access.key",
        happyHome: "/tmp/happy",
        imported: false,
        machineId: "machine-1",
        serverUrl: "https://api.happy.example",
    },
    socketFactory: undefined as
        | undefined
        | ((url: string, options: Record<string, unknown>) => unknown),
}));

vi.mock("../../sources/happy/credentials/importHappyCredentials.js", () => ({
    importHappyCredentials: async () => happyConnection.configuration,
}));

vi.mock("../../sources/happy/connectHappySocket.js", () => ({
    connectHappySocket: (url: string, options: Record<string, unknown>) => {
        if (happyConnection.socketFactory === undefined) {
            throw new Error("This test did not install a Happy socket.");
        }
        return happyConnection.socketFactory(url, options);
    },
}));

const SELECTION = {
    effort: "medium",
    modelId: "gpt-5.6-sol",
    permissionMode: "auto" as AgentPermissionMode,
    providerId: "codex",
};

const databases: ReturnType<typeof moduleDatabase>[] = [];
const temporaryDirectories: string[] = [];
const modules: HappyModule[] = [];

afterEach(async () => {
    for (const module of modules.splice(0)) await module.stop();
    for (const database of databases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
    happyConnection.socketFactory = undefined;
    vi.unstubAllGlobals();
});

const OPUS_MODE = {
    effort: "high",
    modelId: "anthropic/opus-5",
    permissionMode: "read_only" as AgentPermissionMode,
    providerId: "claude",
    serviceTier: null,
};

/** A stored agent whose only interesting part is its metadata. */
function storedAgent(metadata: Record<string, unknown>): AgentConfig {
    return {
        environment: {
            osVersion: "test",
            platform: "darwin",
            shell: "/bin/zsh",
            workingDirectory: "/projects/rig",
        },
        metadata,
    } as AgentConfig;
}

function targetRequest(
    target: Exclude<HappySpawnRequest, { cwd: string }>["target"],
): HappySpawnRequest {
    return {
        ...SELECTION,
        sessionId: "happy-session",
        target,
        workspaceId: "happy-workspace",
    };
}

async function fixture() {
    const database = moduleDatabase(
        [...happySyncMigrations, ...happyIntegrationMigrations, ...happyProjectSyncMigrations],
        "happy-module-test",
    );
    databases.push(database);
    await database.ready;
    // Agent Base runs every root statement and root transaction through one connection FIFO, and
    // the stored configurations below are reached through it too.
    ensureAgentDatabaseConnection(database.database);

    const configs = new Map<string, AgentConfig>();
    const bots = new Map<string, BotRecord>();
    const archivedBots: string[] = [];
    let botReadContext: Context | undefined;
    const botArchiveScopes: { read: Context | undefined; write: Context }[] = [];
    /** Suspends one write where Agent Base resolves the agent, before the write joins. */
    let heldWrite: Promise<void> | undefined;
    const aborted: string[] = [];
    const archivedCompute: string[] = [];
    const activity: { questionAt?: number; textMessageAt?: number; working?: boolean } = {};
    const gitState: { snapshot?: Record<string, unknown>; tracked: Record<string, unknown>[] } = {
        tracked: [],
    };
    const projectAgents = new Map<string, string>();
    const workspaceAgents = new Map<string, string>();
    const pendingMessages: Record<string, unknown>[] = [];
    const steered: {
        agentId: string;
        config: AgentConfig | undefined;
        message: Record<string, unknown>;
        options: Record<string, unknown>;
    }[] = [];
    const projects = new Map([
        [
            "project-1",
            {
                id: "project-1",
                kind: "regular" as const,
                name: "Rig",
                repositoryRef: "/projects/rig",
                status: "active" as const,
            },
        ],
    ]);
    const workspaces = new Map<
        string,
        {
            id: string;
            name: string;
            path: string;
            projectRef: string;
            status: "initializing" | "ready";
        }
    >([
        [
            "workspace-1",
            {
                id: "workspace-1",
                name: "RPC",
                path: "/projects/rig/rpc",
                projectRef: "project-1",
                status: "ready" as const,
            },
        ],
    ]);
    const createdWorkspaces: unknown[] = [];
    const createdBots: unknown[] = [];
    const wornAvatars: {
        botId: string;
        bytes: Uint8Array;
        contentType: string;
        version: number;
    }[] = [];

    const agents = {
        abort: async (_ctx: unknown, agentId: string) => {
            aborted.push(agentId);
        },
        // Storage below takes the boundary Agent Base's own takes: inside a caller's transaction
        // it joins that transaction, and outside one it queues on the connection.
        config: async (ctx: Context, agentId: string) =>
            await inTx(ctx, async () => configs.get(agentId)),
        create: async (_ctx: unknown, config: AgentConfig, options: { id: string }) => {
            configs.set(options.id, config);
            return options.id;
        },
        steer: async (
            _ctx: unknown,
            agentId: string,
            message: Record<string, unknown>,
            options: Record<string, unknown>,
        ) => {
            // The configuration as it stood when the message landed, so a test can tell what was
            // written before the message from what was written after it.
            steered.push({ agentId, config: configs.get(agentId), message, options });
            return { accepted: "created", delivery: "steer", id: options.id };
        },
        updateMetadata: async (
            ctx: Context,
            agentId: string,
            metadata: Record<string, unknown>,
        ) => {
            const gate = heldWrite;
            heldWrite = undefined;
            if (gate !== undefined) await gate;
            await inTx(ctx, async () => {
                const current = configs.get(agentId);
                if (current === undefined) throw new Error("Missing agent config.");
                configs.set(agentId, {
                    ...current,
                    metadata: { ...current.metadata, ...metadata },
                } as AgentConfig);
            });
        },
    };
    const projectModule = {
        attachAgent: async (_ctx: unknown, projectId: string, agentId: string) => {
            projectAgents.set(agentId, projectId);
        },
        get: async (_ctx: unknown, projectId: string) => projects.get(projectId),
        projectForAgent: async (_ctx: unknown, agentId: string) => {
            const projectId = projectAgents.get(agentId);
            return projectId === undefined ? undefined : projects.get(projectId);
        },
    };
    const workspaceModule = {
        attachAgent: async (_ctx: unknown, workspaceId: string, agentId: string) => {
            workspaceAgents.set(agentId, workspaceId);
        },
        createWorkspace: async (_ctx: unknown, projectId: string, request: unknown) => {
            createdWorkspaces.push({ projectId, request });
            const workspace = {
                id: "happy-workspace",
                name: "Workspace",
                path: "/projects/rig/happy-workspace",
                projectRef: projectId,
                status: "initializing" as const,
            };
            workspaces.set(workspace.id, workspace);
            return workspace;
        },
        get: async (_ctx: unknown, workspaceId: string) => workspaces.get(workspaceId),
        resolvePath: async (_ctx: unknown, cwd: string) => ({
            project: {
                id: "project-1",
                kind: "regular" as const,
                name: "Rig",
                repositoryRef: cwd,
                status: "active" as const,
            },
        }),
        workspaceForAgent: async (_ctx: unknown, agentId: string) => workspaceAgents.get(agentId),
    };
    const module = new HappyModule(
        {
            configuration: {
                values: {
                    defaults: { permissionMode: "auto" },
                    settings: { happyIntegration: true },
                },
                version: "test",
            },
            models: [
                {
                    defaultEffort: "medium",
                    effortLevels: ["low", "medium", "high"],
                    id: "gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    providerId: "codex",
                    serviceTiers: ["priority"],
                },
                {
                    defaultEffort: "high",
                    effortLevels: ["high"],
                    id: "anthropic/opus-5",
                    name: "Opus 5",
                    providerId: "claude",
                },
            ],
        } as never,
        {
            archiveAgent: async (_ctx: unknown, agentId: string) => {
                archivedCompute.push(agentId);
            },
        } as never,
        {
            activeRunId: () => (activity.working === true ? "active-run" : undefined),
            observe: () => undefined,
        } as never,
        {
            topLevel: async () => {
                throw new Error("Not a Git repository.");
            },
            onSnapshot: () => () => undefined,
            track: (entity: Record<string, unknown>) => {
                gitState.tracked.push(entity);
            },
            trackedSnapshot: () => gitState.snapshot,
        } as never,
        {
            latestUserOrFinalAssistantTextMessageAt: async () => activity.textMessageAt,
            inputBlocks: new HistoryModule().inputBlocks,
            queuePending: async (_ctx: unknown, message: Record<string, unknown>) => {
                pendingMessages.push(message);
            },
        } as never,
        projectModule as never,
        { list: () => [], onChanged: () => () => undefined } as never,
        { interruptWaits: () => undefined } as never,
        {
            latestQuestionAt: async () => activity.questionAt,
        } as never,
        workspaceModule as never,
        {
            list: async () => [...bots.values()],
            forWorkspace: async (_ctx: unknown, workspaceId: string) =>
                [...bots.values()].find((bot) => bot.workspaceId === workspaceId),
            forAgent: async (ctx: Context, agentId: string) => {
                botReadContext = ctx;
                return [...bots.values()].find((bot) => bot.agentId === agentId);
            },
            archive: async (ctx: Context, botId: string, version: number) => {
                botArchiveScopes.push({ read: botReadContext, write: ctx });
                const bot = bots.get(botId)!;
                expect(version).toBe(bot.version);
                archivedBots.push(botId);
            },
            createWithResult: async (
                _ctx: Context,
                input: { agentId: string; id: string; name: string; workspaceId: string },
            ) => {
                createdBots.push(input);
                const existing = bots.get(input.id);
                if (existing !== undefined) return { bot: existing, created: false };
                const bot = {
                    id: input.id,
                    agentId: input.agentId,
                    createdAt: 1,
                    isAdmin: false,
                    name: input.name,
                    nameConfigured: true,
                    orderKey: "1",
                    path: `/bots/${input.name.toLowerCase().replace(/\W+/g, "_")}`,
                    status: "active" as const,
                    updatedAt: 1,
                    username: input.name.toLowerCase().replace(/\W+/g, "_"),
                    version: 1,
                    workspaceId: input.workspaceId,
                    workspaceUpdatedAt: 1,
                    workspaceVersion: 1,
                } satisfies BotRecord;
                bots.set(bot.id, bot);
                configs.set(bot.agentId, {
                    environment: {
                        osVersion: "test",
                        platform: "darwin",
                        shell: "/bin/zsh",
                        workingDirectory: bot.path,
                    },
                    metadata: { title: bot.name, updatedAt: 1, version: 1 },
                } as AgentConfig);
                return { bot, created: true };
            },
            setAvatar: async (
                _ctx: Context,
                botId: string,
                bytes: Uint8Array,
                contentType: string,
                version: number,
            ) => {
                wornAvatars.push({ botId, bytes, contentType, version });
                return bots.get(botId);
            },
        } as never,
        { enabled: false } as never,
        {
            resolveRoot: async (_ctx: Context, projectId: string, workspaceId?: string) => {
                if (workspaceId !== undefined && workspaces.get(workspaceId)?.status !== "ready")
                    throw new ProjectFileError(409, "conflict", "The workspace is not ready.");
                return {
                    projectId,
                    root:
                        workspaceId === undefined
                            ? projects.get(projectId)!.repositoryRef
                            : workspaces.get(workspaceId)!.path,
                };
            },
            read: async (root: { root: string }) => ({
                content: Buffer.from(root.root).toString("base64"),
                hash: "a".repeat(64),
            }),
        } as never,
    );
    modules.push(module);
    module.beforeStart(database.context, agents as never);

    let releaseWrite: (() => void) | undefined;

    return {
        activity,
        aborted,
        agents,
        archivedCompute,
        archivedBots,
        botArchiveScopes,
        bots,
        configs,
        createdBots,
        createdWorkspaces,
        gitState,
        /** Suspend the next metadata write just before it joins the connection. */
        holdNextWrite: () => {
            heldWrite = new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
        },
        module,
        pendingMessages,
        projectAgents,
        projects,
        releaseHeldWrite: () => releaseWrite?.(),
        steered,
        wornAvatars,
        workspaceAgents,
        workspaces,
    };
}

describe("Happy mobile messages", () => {
    it("reports a plain-folder Git view as unsupported rather than asking the phone to retry", async () => {
        const test = await fixture();
        test.configs.set("viewer", { metadata: {} });
        test.projectAgents.set("viewer", "project-1");
        await expect(
            test.module.gitState(databases.at(-1)!.context, "viewer"),
        ).rejects.toMatchObject({ code: "unsupported" });
    });

    it("resolves reads through fresh catalog ownership, never an agent's working directory", async () => {
        const test = await fixture();
        const ctx = databases.at(-1)!.context;
        test.configs.set("viewer", {
            metadata: {},
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/outside",
            },
        });
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "unsupported" });
        test.projectAgents.set("viewer", "project-1");
        expect(await test.module.readFile(ctx, "viewer", { path: "note.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("/projects/rig").toString("base64"),
        });
        test.workspaceAgents.set("viewer", "workspace-1");
        expect(await test.module.readFile(ctx, "viewer", { path: "note.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("/projects/rig/rpc").toString("base64"),
        });
        test.workspaces.get("workspace-1")!.status = "initializing";
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "conflict" });
        test.configs.set("viewer", { metadata: { archivedAt: 1 } });
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "missing" });
    });

    it("appends personal storage migrations after the released module-wide prefix", async () => {
        const test = await fixture();
        expect(test.module.migrations.map(([key]) => key)).toEqual([
            "001-happy-sync",
            "002-happy-integration-state",
            "003-happy-project-sync",
            "004-personal-session-sync",
            "005-personal-integration-state",
            "006-personal-project-sync",
        ]);
    });

    it("queues the exact rich request without also injecting its display fallback", async () => {
        const test = await fixture();
        test.configs.set("agent-rich", { metadata: { happy: SELECTION } });
        const content = [{ type: "tool_call_request" as const, name: "list_skills" }];
        await test.module.submit(databases.at(-1)!.context, "agent-rich", {
            content,
            images: [],
            remoteMessageId: "happy:rich-1",
            selection: {},
            text: "Requested tool: list_skills",
        });
        expect(test.pendingMessages[0]).toMatchObject({ blocks: content });
        expect(test.steered[0]).toMatchObject({ message: { role: "user", content } });
    });

    it("publishes a pending steering message before delivering it to Agent Base", async () => {
        const test = await fixture();
        test.configs.set("agent-active", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { happy: SELECTION },
        });

        await test.module.submit(databases.at(-1)!.context, "agent-active", {
            images: [],
            remoteMessageId: "happy:mobile-message-1",
            selection: {},
            text: "Steer this active run.",
        });

        expect(test.pendingMessages).toEqual([
            expect.objectContaining({
                agentId: "agent-active",
                blocks: [{ text: "Steer this active run.", type: "text" }],
                delivery: "steer",
                role: "user",
                runId: null,
                status: "pending",
            }),
        ]);
        const pendingId = test.pendingMessages[0]?.id;
        expect(pendingId).toEqual(expect.any(String));
        expect(test.steered).toEqual([
            expect.objectContaining({
                agentId: "agent-active",
                message: {
                    content: [{ text: "Steer this active run.", type: "text" }],
                    role: "user",
                },
                options: expect.objectContaining({
                    id: pendingId,
                    metadata: expect.objectContaining({
                        happy: { remoteMessageId: "happy:mobile-message-1" },
                    }),
                }),
            }),
        ]);
    });
});

describe("HappyModule spawn ownership", () => {
    it("starts at a project root and attaches there", async () => {
        const test = await fixture();

        await expect(
            test.module.spawnSession(
                databases.at(-1)!.context,
                targetRequest({ id: "project-1", kind: "project" }),
            ),
        ).resolves.toEqual({ agentId: "happy-session", type: "ready" });
        expect(test.configs.get("happy-session")?.environment?.workingDirectory).toBe(
            "/projects/rig",
        );
        expect(test.projectAgents.get("happy-session")).toBe("project-1");
        expect(test.configs.get("happy-session")?.metadata).toEqual({
            draft: { ...SELECTION, serviceTier: null, text: "" },
            draftUpdatedAt: expect.any(Number),
        });
        await expect(
            test.module.session(databases.at(-1)!.context, "happy-session"),
        ).resolves.toMatchObject({ lastMode: null });
    });

    it("starts in a ready workspace and attaches there", async () => {
        const test = await fixture();

        await test.module.spawnSession(
            databases.at(-1)!.context,
            targetRequest({ id: "workspace-1", kind: "workspace" }),
        );

        expect(test.configs.get("happy-session")?.environment?.workingDirectory).toBe(
            "/projects/rig/rpc",
        );
        expect(test.workspaceAgents.get("happy-session")).toBe("workspace-1");
    });

    it("returns pending until its deterministic new workspace is ready", async () => {
        const test = await fixture();
        const request = targetRequest({ kind: "newWorkspace", projectId: "project-1" });

        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { type: "pending" },
        );
        expect(test.createdWorkspaces).toEqual([
            {
                projectId: "project-1",
                request: {
                    id: "happy-workspace",
                    name: "Workspace",
                    nameConfigured: false,
                    parentId: "project-1",
                },
            },
        ]);
        test.workspaces.set("happy-workspace", {
            id: "happy-workspace",
            name: "Workspace",
            path: "/projects/rig/happy-workspace",
            projectRef: "project-1",
            status: "ready",
        });

        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { agentId: "happy-session", type: "ready" },
        );
        expect(test.workspaceAgents.get("happy-session")).toBe("happy-workspace");
    });

    it("makes a bot with the identities the request derived, once, and seeds its draft", async () => {
        const test = await fixture();
        const request = targetRequest({ id: "happy-bot", kind: "bot", name: "Release Captain" });

        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { agentId: "happy-session", type: "ready" },
        );
        expect(test.createdBots).toEqual([
            {
                agentId: "happy-session",
                id: "happy-bot",
                name: "Release Captain",
                workspaceId: "happy-workspace",
            },
        ]);
        // A bot lives in its own folder, not in any project or workspace of the catalog.
        expect(test.projectAgents.has("happy-session")).toBe(false);
        expect(test.workspaceAgents.has("happy-session")).toBe(false);
        expect(test.configs.get("happy-session")?.metadata).toMatchObject({
            draft: { ...SELECTION, serviceTier: null, text: "" },
            draftUpdatedAt: expect.any(Number),
            title: "Release Captain",
        });

        // The phone asking again gets the same bot back, with nothing made or written twice.
        const draftUpdatedAt = test.configs.get("happy-session")?.metadata?.["draftUpdatedAt"];
        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { agentId: "happy-session", type: "ready" },
        );
        expect(test.bots.size).toBe(1);
        expect(test.configs.get("happy-session")?.metadata?.["draftUpdatedAt"]).toBe(
            draftUpdatedAt,
        );
    });

    it("refuses a bot spawn on a model this daemon does not have, before anything is made", async () => {
        const test = await fixture();
        await expect(
            test.module.spawnSession(databases.at(-1)!.context, {
                ...targetRequest({ id: "happy-bot", kind: "bot", name: "Release Captain" }),
                modelId: "nope",
            }),
        ).rejects.toThrow("That model is not available in this Happy Agent.");
        expect(test.createdBots).toEqual([]);
    });

    it("creates a missing project folder silently before resolving it", async () => {
        const test = await fixture();
        const root = await mkdtemp(join(tmpdir(), "happy-project-folder-"));
        temporaryDirectories.push(root);
        const projectPath = join(root, "new", "project");

        await test.module.spawnSession(
            databases.at(-1)!.context,
            targetRequest({ kind: "projectFolder", projectPath }),
        );

        expect((await stat(projectPath)).isDirectory()).toBe(true);
        expect(test.configs.get("happy-session")?.environment?.workingDirectory).toBe(projectPath);
        expect(test.projectAgents.get("happy-session")).toBe("project-1");
    });
});

describe("Happy bot pictures from the phone", () => {
    it("puts the picture on the bot behind the session, at the version it read", async () => {
        const test = await fixture();
        const ctx = databases.at(-1)!.context;
        await test.module.spawnSession(
            ctx,
            targetRequest({ id: "happy-bot", kind: "bot", name: "Release Captain" }),
        );
        const face = new Uint8Array([1, 2, 3]);

        await test.module.setSessionAvatar(ctx, "happy-session", face, "image/png");

        expect(test.wornAvatars).toEqual([
            { botId: "happy-bot", bytes: face, contentType: "image/png", version: 1 },
        ]);
    });

    it("refuses a picture for a project session, which shows its project instead", async () => {
        const test = await fixture();
        const ctx = databases.at(-1)!.context;
        await test.module.spawnSession(ctx, targetRequest({ id: "project-1", kind: "project" }));

        await expect(
            test.module.setSessionAvatar(ctx, "happy-session", new Uint8Array([1]), "image/png"),
        ).rejects.toThrow("Only a bot can be given a picture.");
        expect(test.wornAvatars).toEqual([]);
    });
});

describe("Happy session activity metadata", () => {
    it("keeps the newest shared draft, ignoring an older stamp and accepting an equal one", async () => {
        const test = await fixture();
        const context = databases.at(-1)!.context;
        test.configs.set("agent-draft", storedAgent({}));
        const newest = { updatedAt: 2_000, value: { ...OPUS_MODE, text: "Continue elsewhere" } };

        await test.module.saveDraft(context, "agent-draft", newest);
        await test.module.saveDraft(context, "agent-draft", {
            updatedAt: 1_000,
            value: { ...OPUS_MODE, text: "stale" },
        });
        expect(test.configs.get("agent-draft")?.metadata).toMatchObject({
            draft: newest.value,
            draftUpdatedAt: 2_000,
        });

        // The desktop API applies an equal stamp, so Happy must too.
        await test.module.saveDraft(context, "agent-draft", {
            updatedAt: 2_000,
            value: { ...OPUS_MODE, text: "Typed at the same moment" },
        });

        await expect(test.module.session(context, "agent-draft")).resolves.toMatchObject({
            draft: { updatedAt: 2_000, value: { text: "Typed at the same moment" } },
            effort: "high",
            modelId: "anthropic/opus-5",
            permissionMode: "read_only",
            providerId: "claude",
        });
    });

    it("never overwrites a newer draft the desktop API stored while it was reading", async () => {
        const test = await fixture();
        const context = databases.at(-1)!.context;
        test.configs.set(
            "agent-race",
            storedAgent({ draft: { ...OPUS_MODE, text: "one hundred" }, draftUpdatedAt: 100 }),
        );

        // Happy adopts a remote draft stamped 200. Its write is suspended after the decision to
        // write and before the write reaches the store.
        test.holdNextWrite();
        const happy = test.module.saveDraft(context, "agent-race", {
            updatedAt: 200,
            value: { ...OPUS_MODE, text: "two hundred" },
        });
        // PUT /v0/agents/:id/draft compares against the stored stamp and writes a newer draft,
        // which is what Happy must not be able to overwrite with what it read beforehand.
        const desktop = (async () => {
            const config = await test.agents.config(context, "agent-race");
            const storedAt = config?.metadata?.["draftUpdatedAt"];
            if (typeof storedAt === "number" && 300 < storedAt) return;
            await test.agents.updateMetadata(context, "agent-race", {
                draft: { ...OPUS_MODE, text: "three hundred" },
                draftUpdatedAt: 300,
            });
        })();
        // Every step this fixture takes is a microtask, so one macrotask turn is the boundary
        // after which the desktop write has either landed or is queued behind a held connection.
        await new Promise((resolve) => setImmediate(resolve));
        test.releaseHeldWrite();
        await Promise.all([happy, desktop]);

        expect(test.configs.get("agent-race")?.metadata).toMatchObject({
            draft: { text: "three hundred" },
            draftUpdatedAt: 300,
        });
    });

    it("keeps draft text even when its previously selected model is no longer offered", async () => {
        const test = await fixture();
        const context = databases.at(-1)!.context;
        test.configs.set("agent-obsolete-draft", storedAgent({}));

        await test.module.saveDraft(context, "agent-obsolete-draft", {
            updatedAt: 2_000,
            value: {
                effort: "high",
                modelId: "retired-model",
                permissionMode: "auto",
                providerId: "retired-provider",
                serviceTier: null,
                text: "Do not lose this text",
            },
        });

        await expect(test.module.session(context, "agent-obsolete-draft")).resolves.toMatchObject({
            draft: { value: { text: "Do not lose this text" } },
            modelId: "retired-model",
            providerId: "retired-provider",
        });
    });

    it("makes an accepted message's mode the selection an emptied composer falls back to", async () => {
        const test = await fixture();
        const context = databases.at(-1)!.context;
        test.configs.set("agent-selection", storedAgent({}));

        await test.module.submit(context, "agent-selection", {
            images: [],
            remoteMessageId: "happy:message-1",
            selection: { effort: "high", modelId: "anthropic/opus-5", providerId: "claude" },
            text: "Use Opus",
        });

        // Only an accepted message writes lastMode, and it is written after the message lands.
        expect(test.steered[0]?.config?.metadata?.lastMode).toBeUndefined();
        expect(test.configs.get("agent-selection")?.metadata?.lastMode).toEqual({
            ...OPUS_MODE,
            permissionMode: "auto",
        });
        expect(test.configs.get("agent-selection")?.metadata).not.toHaveProperty("happy");

        // Sending clears the draft, and a composer opened afterwards selects from lastMode.
        await test.module.saveDraft(context, "agent-selection", { updatedAt: 3_000, value: null });

        await expect(test.module.session(context, "agent-selection")).resolves.toMatchObject({
            draft: { updatedAt: 3_000, value: null },
            effort: "high",
            modelId: "anthropic/opus-5",
            permissionMode: "auto",
            providerId: "claude",
        });
    });

    it("sends with the complete selection from a mode-only shared draft", async () => {
        const test = await fixture();
        const mode = {
            effort: "high",
            modelId: "gpt-5.6-sol",
            permissionMode: "workspace_write",
            providerId: "codex",
            serviceTier: "priority",
        };
        test.configs.set(
            "agent-draft-selection",
            storedAgent({ draft: { ...mode, text: "" }, draftUpdatedAt: 2_000 }),
        );

        await test.module.submit(databases.at(-1)!.context, "agent-draft-selection", {
            images: [],
            remoteMessageId: "happy:message-2",
            selection: {},
            text: "Use the draft selection",
        });

        expect(test.steered[0]?.options).toMatchObject({
            effort: "high",
            metadata: { mode },
            model: "gpt-5.6-sol",
            permissionMode: "workspace_write",
            provider: "codex",
            serviceTier: "priority",
        });
    });

    it("marks the session working exactly while its durable run is active", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });

        test.activity.working = true;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ working: true });

        test.activity.working = false;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ working: false });
    });

    it("uses the newest visible text message or user-facing question", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });
        test.activity.textMessageAt = 1_000;
        test.activity.questionAt = 2_000;

        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ lastMeaningfulMessageAt: 2_000 });

        test.activity.textMessageAt = 3_000;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ lastMeaningfulMessageAt: 3_000 });
    });

    it("publishes the tracked project Git snapshot using the canonical line counts", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });
        test.projectAgents.set("agent-activity", "project-1");
        test.gitState.snapshot = {
            changedFiles: 39,
            comparison: "ready",
            countsExact: true,
            deletions: 180,
            insertions: 3_032,
        };

        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({
            git: {
                changedFiles: 39,
                countsExact: true,
                deletions: 180,
                insertions: 3_032,
            },
        });
        expect(test.gitState.tracked).toContainEqual({
            path: "/projects/rig",
            projectId: "project-1",
        });
    });
});

describe("archiving a Happy session", () => {
    it("does not spawn a second conversation in a bot's workspace or folder", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "bot-agent",
            workspaceId: "bot-workspace",
            path: "/bots/assistant",
        } as BotRecord);
        for (const request of [
            targetRequest({ kind: "workspace", id: "bot-workspace" }),
            targetRequest({ kind: "projectFolder", projectPath: "/bots/assistant" }),
            { ...SELECTION, sessionId: "another-agent", cwd: "/bots/assistant" },
        ]) {
            await expect(
                test.module.spawnSession(databases.at(-1)!.context, request),
            ).rejects.toThrow("one continuous conversation");
        }
        expect(test.configs.size).toBe(0);
        expect(test.createdWorkspaces).toEqual([]);
    });

    it("archives a bot through its catalog, never by independently archiving its agent", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "agent-1",
            version: 7,
            status: "active",
        } as BotRecord);
        test.configs.set("agent-1", { metadata: { version: 4 } });
        await test.module.archiveSession(databases.at(-1)!.context, "agent-1");
        expect(test.archivedBots).toEqual(["bot-1"]);
        expect(test.archivedCompute).toEqual([]);
        expect(test.configs.get("agent-1")?.metadata).toEqual({ version: 4 });
        const scope = test.botArchiveScopes[0]!;
        expect(scope.read).toBe(scope.write);
        // A real transaction facade expires after commit; the root context does not.
        expect(() => scope.write.db).toThrow("transaction carried by this context has ended");
    });

    it("refuses a late phone message to an archived bot", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "agent-1",
            version: 7,
            status: "archived",
        } as BotRecord);
        test.configs.set("agent-1", { metadata: { version: 4 } });
        await expect(
            test.module.submit(databases.at(-1)!.context, "agent-1", {
                text: "Do not resurrect this bot",
                images: [],
                remoteMessageId: "late-message",
                selection: {},
            }),
        ).rejects.toThrow("archived");
        expect(test.steered).toEqual([]);
        expect(test.pendingMessages).toEqual([]);
    });

    it("archives the durable local agent instead of only stopping and detaching it", async () => {
        const test = await fixture();
        test.configs.set("agent-1", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 4 },
        });

        await test.module.archiveSession(databases.at(-1)!.context, "agent-1");

        expect(test.aborted).toEqual(["agent-1"]);
        expect(test.archivedCompute).toEqual(["agent-1"]);
        expect(test.configs.get("agent-1")?.metadata).toMatchObject({
            archivedAt: expect.any(Number),
            updatedAt: expect.any(Number),
            version: 5,
        });
    });

    it("archives a workspace session that never occupied an attached-client slot", async () => {
        const database = moduleDatabase(
            [...happySyncMigrations, ...happyIntegrationMigrations],
            "happy-unattached-archive-test",
        );
        databases.push(database);
        await database.ready;

        class AutomaticSocket {
            connected = true;
            readonly #listeners = new Map<string, (...values: any[]) => void>();

            connect(): void {
                this.#listeners.get("connect")?.();
            }

            disconnect(): void {
                this.connected = false;
            }

            emit(_event: string, ...values: unknown[]): void {
                const callback = values[1];
                if (typeof callback === "function") {
                    (callback as (answer: unknown) => void)({ result: "success", version: 1 });
                }
            }

            on(event: string, listener: (...values: any[]) => void): void {
                this.#listeners.set(event, listener);
            }
        }

        happyConnection.socketFactory = () => new AutomaticSocket();
        const requests: string[] = [];
        vi.stubGlobal("fetch", (async (input: string | URL, init: RequestInit = {}) => {
            const url = new URL(typeof input === "string" ? input : input.toString());
            requests.push(`${init.method ?? "GET"} ${url.pathname}`);
            if (url.pathname === "/v1/machines") {
                return Response.json({
                    machine: { daemonStateVersion: 1, id: "machine-1", metadataVersion: 1 },
                });
            }
            if (url.pathname === "/v1/sessions") {
                return Response.json({
                    session: {
                        agentState: null,
                        agentStateVersion: 0,
                        id: "remote-unattached",
                        metadataVersion: 1,
                    },
                });
            }
            if (url.pathname === "/v1/sessions/remote-unattached/archive") {
                return Response.json({ ok: true });
            }
            throw new Error(`Unexpected Happy request: ${url.pathname}`);
        }) as typeof fetch);

        let workspaceListener:
            | undefined
            | ((ctx: typeof database.context, event: Record<string, unknown>) => void);
        const archivedWorkspace = {
            archivedAt: 2,
            id: "workspace-archived",
            name: "Archived workspace",
            path: "/projects/rig/archived",
            projectRef: "project-1",
            status: "archived" as const,
        };
        const project = {
            id: "project-1",
            kind: "regular" as const,
            name: "Rig",
            repositoryRef: "/projects/rig",
            status: "active" as const,
        };
        const config: AgentConfig = {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: archivedWorkspace.path,
            },
            metadata: { version: 1 },
        };
        const agents = {
            abort: async () => undefined,
            config: async (_ctx: unknown, agentId: string) =>
                agentId === "agent-unattached" ? config : undefined,
            updateMetadata: async () => undefined,
        };
        const projects = {
            get: async () => project,
            listCatalogPage: async () => ({ projects: [] }),
            onEvent: () => () => undefined,
            projectForAgent: async () => undefined,
        };
        const workspaces = {
            get: async () => archivedWorkspace,
            listAgentIds: async () => ["agent-unattached"],
            listCatalogPage: async () => ({ workspaces: [] }),
            onEvent: (
                listener: (ctx: typeof database.context, event: Record<string, unknown>) => void,
            ) => {
                workspaceListener = listener;
                return () => undefined;
            },
            workspaceForAgent: async () => "workspace-archived",
        };
        const module = new HappyModule(
            {
                configuration: {
                    paths: { agentHome: "/tmp/happy-agent-test" },
                    values: {
                        defaults: { permissionMode: "auto" },
                        settings: { happyIntegration: true },
                    },
                    version: "test",
                },
                models: [
                    {
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                        id: "gpt-5.6-sol",
                        name: "GPT-5.6 Sol",
                        providerId: "codex",
                        serviceTiers: [],
                    },
                ],
            } as never,
            { archiveAgent: async () => undefined } as never,
            { latestAgentEvent: async () => undefined, observe: () => undefined } as never,
            {
                onSnapshot: () => () => undefined,
                track: () => undefined,
                trackedSnapshot: () => undefined,
            } as never,
            { latestUserOrFinalAssistantTextMessageAt: async () => undefined } as never,
            projects as never,
            { list: () => [], onChanged: () => () => undefined } as never,
            { interruptWaits: () => undefined } as never,
            {
                latestQuestionAt: async () => undefined,
                list: async () => [],
                onEvent: () => () => undefined,
            } as never,
            workspaces as never,
            {
                forAgent: async () => undefined,
                list: async () => [],
                onEvent: () => () => undefined,
            } as never,
            { enabled: false } as never,
            {} as never,
        );
        modules.push(module);
        const hooks = module.beforeStart(database.context, agents as never);
        await hooks.afterStart?.(database.context, agents as never);
        await module.settle();

        const sync = createHappySyncDatabase();
        await sync.ensureSession(
            database.context,
            {
                agentId: "agent-unattached",
                credentialFingerprint: "test",
                encryptionKeyBase64: Buffer.alloc(32).toString("base64"),
                encryptionVariant: "legacy",
                sessionId: "agent-unattached",
            },
            1,
        );
        await sync.setRemoteSession(database.context, "agent-unattached", "remote-unattached", 2);

        if (workspaceListener === undefined) throw new Error("Happy did not watch workspaces.");
        workspaceListener(database.context, {
            at: 3,
            eventId: "event-1",
            previousWorkspace: { ...archivedWorkspace, archivedAt: undefined, status: "ready" },
            type: "workspace_archived",
            workspace: archivedWorkspace,
        });
        await module.settle();

        expect(
            requests.filter((request) => request === "POST /v1/sessions/remote-unattached/archive"),
        ).toEqual(["POST /v1/sessions/remote-unattached/archive"]);
    });
});
