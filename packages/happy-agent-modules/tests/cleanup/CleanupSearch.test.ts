import { mkdir, mkdtemp, readdir, lstat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAgentDatabaseConnection, type AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { CleanupModule } from "../../sources/cleanup/index.js";
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
    readonly createdAt: number;
    readonly title?: string;
    readonly subtask?: boolean;
    readonly archived?: boolean;
    readonly folder?: string;
}

/**
 * One installation held in memory, with run activity in a real history store:
 *
 * - bot "Chief" (admin) and bot "Researcher", whose subtask "Survey" has a subtask "Deep dive"
 *   with a hidden subagent that ran yesterday;
 * - task "Fix login" owned by user `ownera`, idle for 40 days, and archived task "Old spike";
 * - project "Payments" with workspace "api" and its child workspace "api-v2", where an agent ran
 *   two days ago, and archived project "Legacy".
 */
async function fixture(options: { readonly roots?: string } = {}) {
    const history = new HistoryModule();
    const db = moduleDatabase(history.migrations, "cleanup-search");
    ensureAgentDatabaseConnection(db.database);
    cleanups.push(() => db.close());
    await db.ready;
    const ctx = db.context;

    const roots = options.roots ?? "/home/me/happy";
    const agents = new Map<string, AgentSpec>([
        ["chiefagent", { createdAt: ago(100), title: "Chief", folder: `${roots}/Bots/chief` }],
        [
            "researcheragent",
            { createdAt: ago(90), title: "Researcher", folder: `${roots}/Bots/researcher` },
        ],
        [
            "survey",
            {
                parent: "researcheragent",
                createdAt: ago(60),
                title: "Survey",
                subtask: true,
                folder: `${roots}/Bots/researcher`,
            },
        ],
        [
            "deepdive",
            {
                parent: "survey",
                createdAt: ago(50),
                title: "Deep dive",
                subtask: true,
                archived: true,
                folder: `${roots}/workspaces/payments/deep-dive`,
            },
        ],
        [
            "deephelper",
            {
                parent: "deepdive",
                createdAt: ago(50),
                title: "Helper",
                folder: `${roots}/workspaces/payments/deep-dive`,
            },
        ],
        [
            "loginagent",
            { createdAt: ago(80), title: "Fix login", folder: `${roots}/Tasks/fix_login` },
        ],
        [
            "spikeagent",
            { createdAt: ago(200), title: "Old spike", folder: `${roots}/Tasks/old_spike` },
        ],
        ["apiagent", { createdAt: ago(30), folder: `${roots}/workspaces/payments/api` }],
        ["v2agent", { createdAt: ago(20), folder: `${roots}/workspaces/payments/api-v2` }],
        ["rootagent", { createdAt: ago(70), folder: "/src/payments" }],
    ]);
    const configs = new Map<string, AgentConfig>(
        [...agents].map(([id, spec]) => [
            id,
            {
                provenance: { createdAt: spec.createdAt },
                ...(spec.folder === undefined
                    ? {}
                    : {
                          environment: {
                              osVersion: "1",
                              platform: "linux",
                              workingDirectory: spec.folder,
                              shell: "/bin/sh",
                          },
                      }),
                metadata: {
                    ...(spec.title === undefined ? {} : { title: spec.title }),
                    ...(spec.subtask === true ? { subtask: true } : {}),
                    ...(spec.archived === true ? { archivedAt: ago(45) } : {}),
                },
            } as AgentConfig,
        ]),
    );
    const agentSystem = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        childOf: async (_ctx: Context, id: string) =>
            [...agents].flatMap(([child, spec]) => (spec.parent === id ? [child] : [])),
    };

    const run = async (agentId: string, start: number, end?: number) => {
        const runId = `run${agentId}${String(start)}`;
        await history.beginMaintenanceRun(ctx, agentId, runId, start);
        if (end !== undefined) {
            await history.finishMaintenanceRun(ctx, agentId, runId, "completed", end);
        }
    };
    await run("chiefagent", ago(3), ago(3) + 1_000);
    await run("researcheragent", ago(30), ago(30) + 1_000);
    await run("deephelper", ago(1), ago(1) + 5_000);
    await run("loginagent", ago(40), ago(40) + 1_000);
    await run("v2agent", ago(2), ago(2) + 1_000);
    await run("rootagent", ago(10), ago(10) + 1_000);

    const bots = [
        {
            id: "chief",
            isAdmin: true,
            status: "active",
            name: "Chief",
            username: "chief",
            agentId: "chiefagent",
            path: `${roots}/Bots/chief`,
            createdAt: ago(100),
        },
        {
            id: "researcher",
            isAdmin: false,
            status: "active",
            name: "Researcher",
            username: "researcher",
            agentId: "researcheragent",
            path: `${roots}/Bots/researcher`,
            createdAt: ago(90),
        },
    ];
    const tasks = [
        {
            id: "login",
            name: "Fix login",
            folderName: "fix_login",
            ownerUserId: "ownera",
            agentId: "loginagent",
            path: `${roots}/Tasks/fix_login`,
            status: "active",
            createdAt: ago(80),
        },
        {
            id: "spike",
            name: "Old spike",
            folderName: "old_spike",
            agentId: "spikeagent",
            path: `${roots}/Tasks/old_spike`,
            status: "archived",
            createdAt: ago(200),
        },
    ];
    const projects = [
        {
            id: "payments",
            name: "Payments",
            storageKey: "payments",
            repositoryRef: "/src/payments",
            status: "active",
            createdAt: ago(100),
        },
        {
            id: "legacy",
            name: "Legacy",
            storageKey: "legacy",
            repositoryRef: "/src/legacy",
            status: "archived",
            createdAt: ago(300),
        },
    ];
    const workspaces = [
        {
            id: "api",
            projectRef: "payments",
            parentId: "payments",
            name: "api",
            storageKey: "api",
            branch: "worktree/api",
            path: `${roots}/workspaces/payments/api`,
            status: "ready",
            createdAt: ago(30),
        },
        {
            id: "apiv2",
            projectRef: "payments",
            parentId: "api",
            name: "api-v2",
            storageKey: "api-v2",
            branch: "worktree/api-v2",
            path: `${roots}/workspaces/payments/api-v2`,
            status: "ready",
            createdAt: ago(20),
        },
        {
            id: "deepws",
            projectRef: "payments",
            parentId: "payments",
            name: "Deep dive",
            storageKey: "deep-dive",
            branch: "worktree/deep-dive",
            path: `${roots}/workspaces/payments/deep-dive`,
            subtaskAgentId: "deepdive",
            status: "archived",
            createdAt: ago(50),
        },
    ];
    const workspaceAgents: Record<string, string[]> = { api: ["apiagent"], apiv2: ["v2agent"] };
    const projectAgents: Record<string, string[]> = { payments: ["rootagent"] };

    const config = {
        botsHome: `${roots}/Bots`,
        tasksHome: `${roots}/Tasks`,
        workspacesHome: `${roots}/workspaces`,
        projectsHome: `${roots}/Projects`,
    };
    const nodeFs = {
        exists: async (_permissions: unknown, path: string) => existsSync(path),
        readdir: async (_permissions: unknown, path: string) => await readdir(path),
        lstat: async (_permissions: unknown, path: string) => {
            const facts = await lstat(path);
            return { isDirectory: facts.isDirectory() };
        },
    };
    const runners = {
        enabled: false,
        defaultRunnerId: undefined,
        machineHome: () => undefined,
        machine: async () => ({ fs: nodeFs }),
    };
    const cleanup = new CleanupModule(
        config as never,
        runners as never,
        {
            list: async () => bots,
            forAgent: async (_ctx: Context, agentId: string) =>
                bots.find((bot) => bot.agentId === agentId),
        } as never,
        { list: async () => tasks } as never,
        {
            isSubtask: (agentConfig: AgentConfig | undefined) =>
                agentConfig?.metadata?.["subtask"] === true,
        } as never,
        {
            listCatalogPage: async () => ({ projects }),
            listAgentIds: async (_ctx: Context, id: string) => projectAgents[id] ?? [],
        } as never,
        {
            enabled: true,
            listCatalogPage: async () => ({ workspaces, cursor: 0 }),
            listAgentIds: async (_ctx: Context, id: string) => workspaceAgents[id] ?? [],
        } as never,
        history,
        {} as never,
        { register: () => undefined } as never,
    );
    const hooks = await cleanup.beforeStart(ctx, agentSystem as never);
    return { ctx, cleanup, hooks, bots, run };
}

function row(page: { results: readonly { item: { kind: string; id: string } }[] }, id: string) {
    const found = page.results.find((result) => result.item.id === id);
    if (found === undefined) throw new Error(`No row ${id}.`);
    return found.item as never as Record<string, unknown>;
}

describe("cleanup search", () => {
    it("rolls activity up through nested subtasks and their hidden subagents", async () => {
        const { ctx, cleanup } = await fixture();
        const page = await cleanup.search(ctx, { limit: 50 });
        const helperRan = ago(1) + 5_000;
        // The hidden helper under the archived second-level subtask ran yesterday.
        expect(row(page, "deepdive")).toMatchObject({
            kind: "subtask",
            status: "archived",
            lastActivityAt: helperRan,
            agents: 2,
            parent: { kind: "subtask", id: "survey", name: "Survey" },
            folder: "/home/me/happy/workspaces/payments/deep-dive",
            branch: "worktree/deep-dive",
        });
        expect(row(page, "survey")).toMatchObject({
            kind: "subtask",
            lastActivityAt: helperRan,
            agents: 3,
            subtasks: { total: 1, active: 0 },
        });
        expect(row(page, "researcher")).toMatchObject({
            kind: "bot",
            lastActivityAt: helperRan,
            agents: 4,
            subtasks: { total: 2, active: 1 },
            folder: "/home/me/happy/Bots/researcher",
        });
        // A bot whose own agent ran three days ago and has nothing under it.
        expect(row(page, "chief")).toMatchObject({ lastActivityAt: ago(3) + 1_000, agents: 1 });
        // An agent that never ran is last active when it was created.
        expect(row(page, "spike")).toMatchObject({ lastActivityAt: ago(200), status: "archived" });
    });

    it("rolls workspace activity into parent workspaces and their project", async () => {
        const { ctx, cleanup } = await fixture();
        const page = await cleanup.search(ctx, { kinds: ["workspace", "project"], limit: 50 });
        expect(row(page, "apiv2")).toMatchObject({ lastActivityAt: ago(2) + 1_000, agents: 1 });
        expect(row(page, "api")).toMatchObject({
            lastActivityAt: ago(2) + 1_000,
            agents: 2,
            workspaces: { total: 1, active: 1 },
            parent: { kind: "project", id: "payments", name: "Payments" },
        });
        expect(row(page, "payments")).toMatchObject({
            lastActivityAt: ago(1) + 5_000,
            workspaces: { total: 3, active: 2 },
            folder: "/src/payments",
        });
        expect(row(page, "legacy")).toMatchObject({ lastActivityAt: ago(300), status: "archived" });
    });

    it("treats a run open now as activity at this moment", async () => {
        const { ctx, cleanup, run } = await fixture();
        await run("spikeagent", ago(5));
        const page = await cleanup.search(ctx, { inactiveSince: ago(7), limit: 50 });
        expect(page.results.map((result) => result.item.id)).not.toContain("spike");
        const fresh = await cleanup.search(ctx, { kinds: ["task"], sort: "recent" });
        expect(fresh.results[0]?.item).toMatchObject({ id: "spike", running: true });
    });

    it("ranks with BM25 and lists by recency or staleness without a query", async () => {
        const { ctx, cleanup } = await fixture();
        const ranked = await cleanup.search(ctx, { query: "login" });
        expect(ranked.sort).toBe("relevance");
        expect(ranked.results[0]?.item.id).toBe("login");
        expect(ranked.results[0]?.score).toBeGreaterThan(0);
        // Folder paths and parents are searchable too, and a word prefix matches.
        const deep = await cleanup.search(ctx, { query: "deep-div" });
        expect(deep.results.map((result) => result.item.id)).toEqual(
            expect.arrayContaining(["deepdive", "deepws"]),
        );

        const recent = await cleanup.search(ctx, { kinds: ["bot", "task"] });
        expect(recent.sort).toBe("recent");
        expect(recent.results.map((result) => result.item.id)).toEqual([
            "researcher",
            "chief",
            "login",
            "spike",
        ]);
        const stale = await cleanup.search(ctx, { kinds: ["bot", "task"], sort: "stale" });
        expect(stale.results.map((result) => result.item.id)).toEqual([
            "spike",
            "login",
            "chief",
            "researcher",
        ]);
    });

    it("filters by time, kind, status, and owner, and pages with a cursor", async () => {
        const { ctx, cleanup } = await fixture();
        const stale = await cleanup.search(ctx, {
            kinds: ["bot", "task", "subtask"],
            inactiveSince: ago(14),
        });
        expect(stale.results.map((result) => result.item.id).sort()).toEqual(["login", "spike"]);
        const active = await cleanup.search(ctx, { kinds: ["task"], activeSince: ago(50) });
        expect(active.results.map((result) => result.item.id)).toEqual(["login"]);
        const created = await cleanup.search(ctx, {
            kinds: ["project"],
            createdAfter: ago(150),
            createdBefore: ago(50),
        });
        expect(created.results.map((result) => result.item.id)).toEqual(["payments"]);
        const archived = await cleanup.search(ctx, { status: "archived", sort: "stale" });
        // The archived subtask and its workspace tie on activity and fall back to kind order.
        expect(archived.results.map((result) => result.item.id)).toEqual([
            "legacy",
            "spike",
            "deepdive",
            "deepws",
        ]);
        const owned = await cleanup.search(ctx, { ownerUserId: "ownera" });
        expect(owned.results.map((result) => result.item.id)).toEqual(["login"]);

        const first = await cleanup.search(ctx, { sort: "stale", limit: 4 });
        expect(first.total).toBe(11);
        expect(first.nextCursor).toBe(4);
        const rest = await cleanup.search(ctx, { sort: "stale", cursor: 4, limit: 50 });
        expect(rest.nextCursor).toBeUndefined();
        const all = await cleanup.search(ctx, { sort: "stale", limit: 50 });
        expect([...first.results, ...rest.results]).toEqual(all.results);
    });

    it("tells what owns a folder and whether its agents are alive", async () => {
        const { ctx, cleanup } = await fixture();
        const owners = await cleanup.folderOwners(
            ctx,
            "/home/me/happy/workspaces/payments/deep-dive/src",
        );
        expect(owners.items.map(({ item, relation }) => [item.id, relation])).toEqual(
            expect.arrayContaining([
                ["deepws", "contains"],
                ["deepdive", "contains"],
            ]),
        );
        expect(
            owners.agents.map(({ agent, relation }) => [agent.agentId, agent.state, relation]),
        ).toEqual(
            expect.arrayContaining([
                ["deepdive", "archived", "contains"],
                ["deephelper", "idle", "contains"],
            ]),
        );
        const bots = await cleanup.folderOwners(ctx, "/home/me/happy/Bots");
        expect(bots.items.map(({ item, relation }) => [item.id, relation])).toEqual(
            expect.arrayContaining([
                ["chief", "inside"],
                ["researcher", "inside"],
                ["survey", "inside"],
            ]),
        );
        const nobody = await cleanup.folderOwners(ctx, "/elsewhere");
        expect(nobody.items).toEqual([]);
        expect(nobody.agents).toEqual([]);
    });

    it("lists Happy folders no record names, looking inside folders that hold known ones", async () => {
        const roots = await mkdtemp(join(tmpdir(), "cleanup-orphans-"));
        cleanups.push(() => rm(roots, { recursive: true, force: true }));
        for (const folder of [
            "Bots/chief",
            "Bots/researcher",
            "Bots/gone_bot",
            "Tasks/fix_login",
            "workspaces/payments/api",
            "workspaces/payments/api-v2",
            "workspaces/payments/leftover",
            "workspaces/forgotten/old",
            "Projects/cloned-once",
        ]) {
            await mkdir(join(roots, folder), { recursive: true });
        }
        const { ctx, cleanup } = await fixture({ roots });
        const found = await cleanup.orphanFolders(ctx);
        expect(found.orphans.map((orphan) => [orphan.root, orphan.folder]).sort()).toEqual(
            [
                ["bots", join(roots, "Bots/gone_bot")],
                ["projects", join(roots, "Projects/cloned-once")],
                ["workspaces", join(roots, "workspaces/forgotten")],
                ["workspaces", join(roots, "workspaces/payments/leftover")],
            ].sort(),
        );
        expect(found.truncated).toBe(false);
        expect(found.roots.every((root) => root.error === undefined)).toBe(true);
    });
});

describe("cleanup admin gating", () => {
    it("offers its tools only to active admin bots and checks again on every call", async () => {
        const { ctx, cleanup, hooks, bots } = await fixture();
        const toolsFor = async (agentId: string) =>
            (await hooks.tools!(ctx, { agent: { id: agentId } } as never)).map((tool) => tool.name);
        expect(await toolsFor("chiefagent")).toEqual([
            "search_instance",
            "find_folder_owners",
            "find_orphan_folders",
            "preview_delete",
            "delete_permanently",
        ]);
        expect(await toolsFor("researcheragent")).toEqual([]);
        expect(await toolsFor("loginagent")).toEqual([]);

        await expect(cleanup.searchForAgent(ctx, "chiefagent", {})).resolves.toMatchObject({
            total: 11,
        });
        await expect(cleanup.searchForAgent(ctx, "researcheragent", {})).rejects.toThrow(
            "Only an active admin bot can search and clean up this installation.",
        );
        bots[0]!.status = "archived";
        expect(await toolsFor("chiefagent")).toEqual([]);
        await expect(cleanup.folderOwnersForAgent(ctx, "chiefagent", "/")).rejects.toThrow(
            "Only an active admin bot",
        );
        await expect(cleanup.orphanFoldersForAgent(ctx, "chiefagent")).rejects.toThrow(
            "Only an active admin bot",
        );
        const target = { kind: "task", id: "spike" } as const;
        await expect(cleanup.previewForAgent(ctx, "chiefagent", target)).rejects.toThrow(
            "Only an active admin bot",
        );
        await expect(
            cleanup.deleteForAgent(ctx, "researcheragent", target, "anything"),
        ).rejects.toThrow("Only an active admin bot");
    });
});
