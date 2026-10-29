import { ensureAgentDatabaseConnection, type AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { CleanupModule, type CleanupDeletionCall } from "../../sources/cleanup/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number): number => NOW - days * DAY;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface AgentSpec {
    readonly parent?: string;
    readonly title: string;
    readonly subtask?: boolean;
}

type Status = "active" | "archived";

/**
 * One installation held in fakes that record what deletion asks of them, with runs in a real
 * history store:
 *
 * - admin bot "Chief", whose hidden helper `chiefhelper` is the agent asking;
 * - bot "Researcher", whose subtask "Survey" works in workspace "survey" and has a running helper;
 * - task "Fix login" with a shared-folder subtask "Notes";
 * - registered project "Payments" with a root agent and workspaces "api" > "api-v2" and "survey";
 * - project "Cloned", which Happy Agent cloned into its own folder, with no workspaces.
 */
async function fixture() {
    const history = new HistoryModule();
    const db = moduleDatabase(history.migrations, "cleanup-deletion");
    ensureAgentDatabaseConnection(db.database);
    cleanups.push(() => db.close());
    await db.ready;
    const ctx = db.context;
    const log: string[] = [];

    const agents = new Map<string, AgentSpec>([
        ["chiefagent", { title: "Chief" }],
        ["chiefhelper", { parent: "chiefagent", title: "Helper" }],
        ["researcheragent", { title: "Researcher" }],
        ["survey", { parent: "researcheragent", title: "Survey", subtask: true }],
        ["surveyhelper", { parent: "survey", title: "Survey helper" }],
        ["loginagent", { title: "Fix login" }],
        ["notes", { parent: "loginagent", title: "Notes", subtask: true }],
        ["rootagent", { title: "Payments root" }],
        ["apiagent", { title: "API work" }],
        ["v2agent", { title: "API v2 work" }],
    ]);
    const configOf = (id: string): AgentConfig | undefined => {
        const spec = agents.get(id);
        if (spec === undefined) return undefined;
        return {
            provenance: { createdAt: ago(10) },
            metadata: { title: spec.title, ...(spec.subtask === true ? { subtask: true } : {}) },
        } as AgentConfig;
    };
    const agentSystem = {
        config: async (_ctx: Context, id: string) => configOf(id),
        childOf: async (_ctx: Context, id: string) =>
            [...agents].flatMap(([child, spec]) => (spec.parent === id ? [child] : [])),
        parentOf: async (_ctx: Context, id: string) => agents.get(id)?.parent ?? null,
        erase: async (_ctx: Context, id: string) => {
            log.push(`erase ${id}`);
            agents.delete(id);
        },
    };
    await history.beginMaintenanceRun(ctx, "surveyhelper", "running-run", ago(0));

    const bots = [
        {
            id: "chief",
            isAdmin: true,
            status: "active" as Status,
            version: 3,
            name: "Chief",
            username: "chief",
            agentId: "chiefagent",
            path: "/happy/Bots/chief",
            createdAt: ago(100),
        },
        {
            id: "researcher",
            isAdmin: false,
            status: "active" as Status,
            version: 5,
            name: "Researcher",
            username: "researcher",
            agentId: "researcheragent",
            path: "/happy/Bots/researcher",
            createdAt: ago(90),
        },
    ];
    const tasks = [
        {
            id: "login",
            name: "Fix login",
            folderName: "fix_login",
            agentId: "loginagent",
            path: "/happy/Tasks/fix_login",
            status: "active" as Status,
            version: 7,
            createdAt: ago(80),
        },
    ];
    const projects = [
        {
            id: "payments",
            kind: "regular",
            name: "Payments",
            storageKey: "payments",
            repositoryRef: "/src/payments",
            status: "active" as Status,
            createdAt: ago(100),
        },
        {
            id: "cloned",
            kind: "regular",
            name: "Cloned",
            storageKey: "cloned",
            repositoryRef: "/happy/Projects/cloned",
            remoteSource: { url: "https://example.com/cloned.git" },
            status: "archived" as Status,
            createdAt: ago(100),
        },
        {
            id: "home",
            kind: "home",
            name: "Home",
            storageKey: "home",
            repositoryRef: "/home/me",
            status: "active" as Status,
            createdAt: ago(300),
        },
    ];
    const workspace = (id: string, parentId: string, extra: { subtaskAgentId?: string } = {}) => ({
        id,
        projectRef: "payments",
        parentId,
        name: id,
        storageKey: id,
        branch: `worktree/${id}`,
        kind: "git_worktree",
        gitCommonDir: "/src/payments/.git",
        path: `/happy/workspaces/payments/${id}`,
        status: "ready",
        createdAt: ago(30),
        ...extra,
    });
    const workspaces = [
        workspace("api", "payments"),
        workspace("apiv2", "api"),
        workspace("surveyws", "payments", { subtaskAgentId: "survey" }),
    ];
    const workspaceAgents: Record<string, string[]> = { api: ["apiagent"], apiv2: ["v2agent"] };
    const projectAgents: Record<string, string[]> = { payments: ["rootagent"] };

    let registered:
        | {
              executor: (
                  ctx: Context,
                  call: { arguments: CleanupDeletionCall; kv: unknown },
              ) => Promise<null>;
          }
        | undefined;
    const invoked: { function: string; arguments: CleanupDeletionCall }[] = [];
    const cleanup = new CleanupModule(
        { botsHome: "/happy/Bots" } as never,
        { enabled: false, machineHome: () => undefined } as never,
        {
            list: async () => bots,
            get: async (_ctx: Context, id: string) => bots.find((bot) => bot.id === id),
            forAgent: async (_ctx: Context, agentId: string) =>
                bots.find((bot) => bot.agentId === agentId),
            archive: async (_ctx: Context, id: string, version: number) => {
                log.push(`archive bot ${id} v${String(version)}`);
                bots.find((bot) => bot.id === id)!.status = "archived";
            },
            purge: async (_ctx: Context, id: string) => {
                log.push(`purge bot ${id}`);
            },
        } as never,
        {
            list: async () => tasks,
            get: async (_ctx: Context, id: string) => tasks.find((task) => task.id === id),
            archive: async (_ctx: Context, id: string, version: number) => {
                log.push(`archive task ${id} v${String(version)}`);
                tasks.find((task) => task.id === id)!.status = "archived";
            },
            purge: async (_ctx: Context, id: string) => {
                log.push(`purge task ${id}`);
            },
        } as never,
        {
            isSubtask: (agentConfig: AgentConfig | undefined) =>
                agentConfig?.metadata?.["subtask"] === true,
        } as never,
        {
            listCatalogPage: async () => ({ projects }),
            listAgentIds: async (_ctx: Context, id: string) => projectAgents[id] ?? [],
            get: async (_ctx: Context, id: string) => projects.find((project) => project.id === id),
            managedDirectory: async (project: (typeof projects)[number]) =>
                project.remoteSource === undefined ? undefined : project.repositoryRef,
            archive: async (_ctx: Context, id: string) => {
                log.push(`archive project ${id}`);
                projects.find((project) => project.id === id)!.status = "archived";
                for (const each of workspaces) each.status = "archiving";
            },
            purge: async (_ctx: Context, id: string) => {
                log.push(`purge project ${id}`);
            },
        } as never,
        {
            enabled: true,
            listCatalogPage: async () => ({ workspaces }),
            listAgentIds: async (_ctx: Context, id: string) => workspaceAgents[id] ?? [],
            get: async (_ctx: Context, id: string) => workspaces.find((each) => each.id === id),
            archive: async (_ctx: Context, id: string) => {
                log.push(`archive workspace ${id}`);
                const visit = (parentId: string) => {
                    for (const each of workspaces) {
                        if (each.id === parentId || each.parentId === parentId) {
                            if (each.status !== "archiving") {
                                each.status = "archiving";
                                if (each.id !== parentId) visit(each.id);
                            }
                        }
                    }
                };
                visit(id);
            },
            purge: async (_ctx: Context, id: string) => {
                log.push(`purge workspace ${id}`);
            },
        } as never,
        history,
        {
            abort: async (_ctx: Context, agentId: string) => {
                log.push(`abort ${agentId}`);
            },
        } as never,
        {
            register: (registration: typeof registered) => {
                registered = registration;
            },
            invoke: async (_ctx: Context, call: (typeof invoked)[number]) => {
                invoked.push(call);
            },
        } as never,
    );
    await cleanup.beforeStart(ctx, agentSystem as never);
    const runDeletion = async (call: CleanupDeletionCall) => {
        const values = new Map<string, unknown>();
        const kv = {
            read: async (_ctx: Context, key: string) => values.get(key),
            write: async (_ctx: Context, key: string, value: unknown) => {
                values.set(key, value);
            },
        };
        await registered!.executor(ctx, { arguments: call, kv });
    };
    return { ctx, cleanup, log, invoked, runDeletion, agents, workspaces };
}

describe("cleanup deletion preview", () => {
    it("lists a task with its subtasks, agents descendants first, and its folder, changing nothing", async () => {
        const { ctx, cleanup, log } = await fixture();
        const plan = await cleanup.preview(ctx, "chiefhelper", { kind: "task", id: "login" });
        expect(plan.target).toMatchObject({ kind: "task", id: "login", name: "Fix login" });
        expect(plan.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
            "task:login",
            "subtask:notes",
        ]);
        expect(plan.agents.map((agent) => agent.agentId)).toEqual(["notes", "loginagent"]);
        expect(plan.folders).toEqual(["/happy/Tasks/fix_login"]);
        expect(plan.branches).toEqual([]);
        expect(plan.keptFolders).toEqual([]);
        expect(plan.confirmation).toMatch(/^[0-9a-f]{12}$/u);
        expect(log).toEqual([]);
    });

    it("closes a project over its workspaces, their resident subtasks, and every agent below them", async () => {
        const { ctx, cleanup } = await fixture();
        const plan = await cleanup.preview(ctx, "chiefhelper", { kind: "project", id: "payments" });
        expect(plan.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
            "project:payments",
            "subtask:survey",
            "workspace:apiv2",
            "workspace:api",
            "workspace:surveyws",
        ]);
        // Descendants come before the agents above them, wherever they were reached from.
        expect(plan.agents.map((agent) => agent.agentId)).toEqual([
            "v2agent",
            "apiagent",
            "surveyhelper",
            "survey",
            "rootagent",
        ]);
        expect(plan.agents.find((agent) => agent.agentId === "surveyhelper")?.state).toBe(
            "running",
        );
        expect(plan.folders).toEqual([
            "/happy/workspaces/payments/api",
            "/happy/workspaces/payments/apiv2",
            "/happy/workspaces/payments/surveyws",
        ]);
        expect(plan.branches.map((branch) => branch.branch)).toEqual([
            "worktree/apiv2",
            "worktree/api",
            "worktree/surveyws",
        ]);
        // A folder a person registered is never removed.
        expect(plan.keptFolders).toEqual(["/src/payments"]);
    });

    it("removes the folder of a project Happy Agent cloned", async () => {
        const { ctx, cleanup } = await fixture();
        const plan = await cleanup.preview(ctx, "chiefhelper", { kind: "project", id: "cloned" });
        expect(plan.folders).toEqual(["/happy/Projects/cloned"]);
        expect(plan.keptFolders).toEqual([]);
    });

    it("takes a workspace-bound subtask's workspace with it", async () => {
        const { ctx, cleanup } = await fixture();
        const plan = await cleanup.preview(ctx, "chiefhelper", { kind: "subtask", id: "survey" });
        expect(plan.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
            "subtask:survey",
            "workspace:surveyws",
        ]);
        expect(plan.agents.map((agent) => agent.agentId)).toEqual(["surveyhelper", "survey"]);
    });

    it("refuses to delete the asking agent, anything above it, or the home project", async () => {
        const { ctx, cleanup } = await fixture();
        await expect(
            cleanup.preview(ctx, "chiefhelper", { kind: "bot", id: "chief" }),
        ).rejects.toThrow("An admin cannot delete itself or anything it runs inside.");
        await expect(
            cleanup.preview(ctx, "survey", { kind: "subtask", id: "survey" }),
        ).rejects.toThrow("would remove the agent asking for it");
        await expect(
            cleanup.preview(ctx, "surveyhelper", { kind: "bot", id: "researcher" }),
        ).rejects.toThrow("would remove the agent asking for it or an agent it works under");
        await expect(
            cleanup.preview(ctx, "chiefhelper", { kind: "project", id: "home" }),
        ).rejects.toThrow("The home project cannot be deleted.");
        await expect(
            cleanup.preview(ctx, "chiefhelper", { kind: "task", id: "missing" }),
        ).rejects.toThrow('No task "missing" exists to delete.');
    });
});

describe("cleanup deletion", () => {
    it("refuses a confirmation that does not name the current plan, and changes nothing", async () => {
        const { ctx, cleanup, log, invoked, agents } = await fixture();
        const target = { kind: "task", id: "login" } as const;
        const plan = await cleanup.preview(ctx, "chiefhelper", target);
        await expect(cleanup.delete(ctx, "chiefhelper", target, "000000000000")).rejects.toThrow(
            "has changed since it was previewed",
        );
        // A subagent started after the preview changes what would go.
        agents.set("latecomer", { parent: "loginagent", title: "Latecomer" });
        await expect(cleanup.delete(ctx, "chiefhelper", target, plan.confirmation)).rejects.toThrow(
            "has changed since it was previewed",
        );
        expect(log).toEqual([]);
        expect(invoked).toEqual([]);
    });

    it("stops and archives everything at once, then erases agents before removing records", async () => {
        const { ctx, cleanup, log, invoked, runDeletion, agents } = await fixture();
        const target = { kind: "project", id: "payments" } as const;
        const preview = await cleanup.preview(ctx, "chiefhelper", target);
        const plan = await cleanup.delete(ctx, "chiefhelper", target, preview.confirmation);
        expect(plan.confirmation).toBe(preview.confirmation);
        expect(log).toEqual([
            // Only the top of each erased tree is aborted; an abort carries its descendants.
            "abort v2agent",
            "abort apiagent",
            "abort survey",
            "abort rootagent",
            // The project's archival takes its workspaces, so none is archived twice.
            "archive project payments",
        ]);
        expect(invoked).toHaveLength(1);
        expect(invoked[0]!.arguments).toEqual({
            agents: ["v2agent", "apiagent", "surveyhelper", "survey", "rootagent"],
            workspaces: ["apiv2", "api", "surveyws"],
            tasks: [],
            bots: [],
            projects: ["payments"],
        });

        log.length = 0;
        await runDeletion(invoked[0]!.arguments);
        expect(log).toEqual([
            "erase v2agent",
            "erase apiagent",
            "erase surveyhelper",
            "erase survey",
            "erase rootagent",
            "purge workspace apiv2",
            "purge workspace api",
            "purge workspace surveyws",
            "purge project payments",
        ]);
        expect(agents.has("survey")).toBe(false);

        // A restart replays the call; every finished step is skipped or does nothing.
        log.length = 0;
        await runDeletion(invoked[0]!.arguments);
        expect(log.filter((entry) => entry.startsWith("erase"))).toEqual([]);
    });

    it("archives an active task and bot with their current versions before deleting them", async () => {
        const { ctx, cleanup, log, invoked, runDeletion } = await fixture();
        const task = { kind: "task", id: "login" } as const;
        await cleanup.delete(
            ctx,
            "chiefhelper",
            task,
            (await cleanup.preview(ctx, "chiefhelper", task)).confirmation,
        );
        const bot = { kind: "bot", id: "researcher" } as const;
        await cleanup.delete(
            ctx,
            "chiefhelper",
            bot,
            (await cleanup.preview(ctx, "chiefhelper", bot)).confirmation,
        );
        expect(log).toEqual([
            "abort loginagent",
            "archive task login v7",
            "abort researcheragent",
            "archive workspace surveyws",
            "archive bot researcher v5",
        ]);
        log.length = 0;
        await runDeletion(invoked[1]!.arguments);
        expect(log).toEqual([
            "erase surveyhelper",
            "erase survey",
            "erase researcheragent",
            "purge workspace surveyws",
            "purge bot researcher",
        ]);
    });
});
