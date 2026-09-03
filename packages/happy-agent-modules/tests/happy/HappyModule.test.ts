import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentConfig, AgentPermissionMode } from "@slopus/happy-agent-base";
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

    const configs = new Map<string, AgentConfig>();
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

    const agents = {
        abort: async (_ctx: unknown, agentId: string) => {
            aborted.push(agentId);
        },
        config: async (_ctx: unknown, agentId: string) => configs.get(agentId),
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
            steered.push({ agentId, message, options });
            return { accepted: "created", delivery: "steer", id: options.id };
        },
        updateMetadata: async (
            _ctx: unknown,
            agentId: string,
            metadata: Record<string, unknown>,
        ) => {
            const current = configs.get(agentId);
            if (current === undefined) throw new Error("Missing agent config.");
            configs.set(agentId, {
                ...current,
                metadata: { ...current.metadata, ...metadata },
            } as AgentConfig);
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
            onSnapshot: () => () => undefined,
            track: (entity: Record<string, unknown>) => {
                gitState.tracked.push(entity);
            },
            trackedSnapshot: () => gitState.snapshot,
        } as never,
        {
            latestUserOrFinalAssistantTextMessageAt: async () => activity.textMessageAt,
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
    );
    modules.push(module);
    module.beforeStart(database.context, agents as never);

    return {
        activity,
        aborted,
        agents,
        archivedCompute,
        configs,
        createdWorkspaces,
        gitState,
        module,
        pendingMessages,
        projectAgents,
        projects,
        steered,
        workspaceAgents,
        workspaces,
    };
}

describe("Happy mobile messages", () => {
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

describe("Happy session activity metadata", () => {
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
