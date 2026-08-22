import { join } from "node:path";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    WorkspacesModule,
    workspaceMigrations,
    workspaceSchema,
} from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents, resolveModuleHooks } from "../support/moduleHooks.js";
import { temporaryWorkspacesCatalog } from "../support/workspacesModule.js";

function workspaceDatabase(name: string): ReturnType<typeof moduleDatabase> {
    const database = moduleDatabase([], name);
    const ready = database.ready.then(async () => {
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
    });
    return { ...database, ready };
}

const ROW = {
    id: "workspace-1",
    projectRef: "project-1",
    parentId: "project-1",
    name: "Workspace",
    nameConfigured: false,
    branch: "worktree/workspace",
    storageKey: "workspace",
    kind: "git_worktree",
    path: "/tmp/project-1/workspace",
    presence: "present",
    status: "ready",
    orderKey: "5",
    version: 1,
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    initializationAttempt: 1,
    createdAt: 1,
    updatedAt: 1,
};

describe("WorkspacesModule", () => {
    it("is assembled from modules and takes its managed path from configuration", async () => {
        const { config, workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();

        expect(workspaces.name).toBe("workspaces");
        expect(workspaces.migrations).toEqual(workspaceMigrations);
        expect(workspacesDirectory).toContain("workspaces");
        expect(workspaces.pathForStorageKey("acme", "retry-policy")).toBe(
            join(workspacesDirectory, "acme", "retry-policy"),
        );
        expect(config.workspacesHome.endsWith("workspaces")).toBe(true);
    });

    it("requires a branch, folder, and kind on every workspace row", () => {
        expect(Value.Check(workspaceSchema, ROW)).toBe(true);

        const { branch: _branch, ...withoutBranch } = ROW;
        expect(Value.Check(workspaceSchema, withoutBranch)).toBe(false);
        const { path: _path, ...withoutPath } = ROW;
        expect(Value.Check(workspaceSchema, withoutPath)).toBe(false);
        const { kind: _kind, ...withoutKind } = ROW;
        expect(Value.Check(workspaceSchema, withoutKind)).toBe(false);
    });

    it("does not expose a tool for transferring an agent between workspaces", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-tool-surface-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, workspaces, primaryAgents());
            const tools = await hooks.tools?.(database.context, {
                agent: { id: "agent-1" },
            } as never);

            expect(tools?.map((tool) => tool.name)).toEqual([
                "create_workspace",
                "list_workspaces",
                "get_workspace",
                "rename_workspace",
                "archive_workspace",
                "get_workspace_branch_metadata",
            ]);
        } finally {
            database.close();
        }
    });

    it("drops obsolete replay tables in the forward migration", async () => {
        const database = workspaceDatabase("workspaces-drop-replay-test");
        await database.ready;
        try {
            const rows = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table'
                      AND name IN (
                          'happy_agent_module_workspace_operation_receipts',
                          'happy_agent_module_workspace_mutation_proofs'
                      )`,
            );
            expect(rows).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("reserves a portable folder key and branch that follow the name", async () => {
        const { workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-reserve-test");
        await database.ready;
        try {
            const { created, workspace } = await workspaces.reserve(database.context, {
                id: "workspace-1",
                operationId: "reserve-1",
                projectRef: "acme",
                name: "Retry policy rewrite",
            });

            expect(created).toBe(true);
            expect(workspace).toMatchObject({
                name: "Retry policy rewrite",
                nameConfigured: false,
                storageKey: "retry-policy-rewrite",
                branch: "worktree/retry-policy-rewrite",
                path: join(workspacesDirectory, "acme", "retry-policy-rewrite"),
                kind: "git_worktree",
                presence: "missing",
                status: "initializing",
                version: 1,
                initializationAttempt: 1,
            });
        } finally {
            database.close();
        }
    });

    it("uses reservation hooks only while choosing names unavailable to the catalog", async () => {
        const { workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-collision-test");
        await database.ready;
        try {
            const workspace = await workspaces.reserve(
                database.context,
                { id: "workspace-3", projectRef: "acme", name: "Cache warmup" },
                {
                    isStorageKeyUnavailable: (key) => key === "cache-warmup",
                    isBranchUnavailable: (branch) =>
                        branch === "worktree/cache-warmup" || branch === "worktree/cache-warmup-2",
                    pathForStorageKey: (key) => join(workspacesDirectory, "acme", key),
                },
            );

            expect(workspace.workspace).toMatchObject({
                name: "Cache warmup",
                storageKey: "cache-warmup-2",
                branch: "worktree/cache-warmup-3",
                path: join(workspacesDirectory, "acme", "cache-warmup-2"),
            });
        } finally {
            database.close();
        }
    });

    it("returns the same workspace for a repeated reservation and rejects different details", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-retry-test");
        await database.ready;
        try {
            const input = {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
                baseRef: "origin/main",
            };
            const first = await workspaces.reserve(database.context, input);
            const again = await workspaces.reserve(database.context, input);

            expect(again).toEqual({ created: false, workspace: first.workspace });
            await expect(
                workspaces.reserve(database.context, { ...input, projectRef: "other" }),
            ).rejects.toThrow("another project");
            await expect(
                workspaces.reserve(database.context, { ...input, baseRef: "origin/release" }),
            ).rejects.toThrow("different base");
        } finally {
            database.close();
        }
    });

    it("durably places agents in a workspace and keeps their manual order", async () => {
        const { config, git, projects, workspaces } = await temporaryWorkspacesCatalog();
        const events: string[] = [];
        const unsubscribe = workspaces.onEventTransactional((_ctx, event) => {
            events.push(event.type);
        });
        const database = workspaceDatabase("workspace-agent-associations-test");
        await database.ready;
        try {
            workspaces.beforeStart(database.context, { parentOf: async () => null } as never);
            await workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: "acme",
                name: "First workspace",
            });
            await workspaces.reserve(database.context, {
                id: "workspace-2",
                projectRef: "acme",
                name: "Second workspace",
            });

            await workspaces.attachAgent(database.context, "workspace-1", "agent-1");
            await workspaces.attachAgent(database.context, "workspace-1", "agent-2");
            await workspaces.attachAgent(database.context, "workspace-1", "agent-3");
            const attached = await workspaces.listAgents(database.context, "workspace-1");
            expect(attached.map((association) => association.agentId)).toEqual([
                "agent-1",
                "agent-2",
                "agent-3",
            ]);
            expect(new Set(attached.map((association) => association.orderKey)).size).toBe(3);

            await workspaces.reorderAgent(database.context, "workspace-1", "agent-3", null);
            const reordered = await workspaces.listAgents(database.context, "workspace-1");
            expect(await workspaces.listAgentIds(database.context, "workspace-1")).toEqual([
                "agent-3",
                "agent-1",
                "agent-2",
            ]);
            expect(reordered[0]?.orderKey).not.toBe(attached[2]?.orderKey);
            expect(reordered.slice(1)).toEqual(attached.slice(0, 2));

            const restarted = new WorkspacesModule(config, projects, git);
            expect(await restarted.listAgents(database.context, "workspace-1")).toEqual(reordered);

            await expect(
                workspaces.attachAgent(database.context, "workspace-2", "agent-1"),
            ).rejects.toThrow('Agent "agent-1" is already attached to workspace "workspace-1".');
            expect(await workspaces.workspaceForAgent(database.context, "agent-1")).toBe(
                "workspace-1",
            );
            expect(await workspaces.listAgentIds(database.context, "workspace-1")).toEqual([
                "agent-3",
                "agent-1",
                "agent-2",
            ]);
            expect(await workspaces.listAgentIds(database.context, "workspace-2")).toEqual([]);
            expect(events).toEqual([
                "workspace_created",
                "workspace_created",
                "workspace_agent_attached",
                "workspace_agent_attached",
                "workspace_agent_attached",
                "workspace_agent_reordered",
            ]);
        } finally {
            unsubscribe();
            database.close();
        }
    });

    it("attaches a managed catalog root only through the explicit managed boundary", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspace-managed-root-agent-test");
        await database.ready;
        try {
            workspaces.beforeStart(database.context, {
                parentOf: async (_ctx: unknown, agentId: string) =>
                    agentId === "managed-agent" ? "parent-agent" : null,
            } as never);
            const workspace = await workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Managed root agent",
            });

            await expect(
                workspaces.attachAgent(database.context, workspace.workspace.id, "managed-agent"),
            ).rejects.toThrow("Only a top-level agent can be attached to a workspace.");
            await expect(
                workspaces.attachManagedRootAgent(
                    database.context,
                    workspace.workspace.id,
                    "root-agent",
                ),
            ).rejects.toThrow("Only an agent managed by another agent");

            await workspaces.attachManagedRootAgent(
                database.context,
                workspace.workspace.id,
                "managed-agent",
            );
            expect(await workspaces.listAgentIds(database.context, workspace.workspace.id)).toEqual(
                ["managed-agent"],
            );
        } finally {
            database.close();
        }
    });

    it("places workspaces under an implicit project root and orders only siblings", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspace-hierarchy-test");
        await database.ready;
        try {
            const root = await workspaces.reserve(database.context, {
                id: "workspace-root",
                projectRef: "acme",
                name: "Root workspace",
            });
            await workspaces.reserve(database.context, {
                id: "workspace-child-a",
                projectRef: "acme",
                parentId: root.workspace.id,
                name: "Child A",
            });
            const childB = await workspaces.reserve(database.context, {
                id: "workspace-child-b",
                projectRef: "acme",
                parentId: root.workspace.id,
                name: "Child B",
            });

            expect(root.workspace.parentId).toBe("acme");
            expect(childB.workspace.parentId).toBe(root.workspace.id);
            expect(
                (await workspaces.listChildren(database.context, "acme")).map(
                    (workspace) => workspace.id,
                ),
            ).toEqual(["workspace-root"]);
            expect(
                (await workspaces.listChildren(database.context, "acme", root.workspace.id)).map(
                    (workspace) => workspace.id,
                ),
            ).toEqual(["workspace-child-b", "workspace-child-a"]);

            await workspaces.reorder(database.context, {
                workspaceId: "workspace-child-a",
                afterId: null,
            });
            expect(
                (await workspaces.listChildren(database.context, "acme", root.workspace.id)).map(
                    (workspace) => workspace.id,
                ),
            ).toEqual(["workspace-child-a", "workspace-child-b"]);
        } finally {
            database.close();
        }
    });

    it("rejects an invalid workspace ancestor chain while resolving an agent owner", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspace-ancestor-safety-test");
        await database.ready;
        try {
            workspaces.beforeStart(database.context, { parentOf: async () => null } as never);
            const workspace = await workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Workspace",
            });
            await workspaces.attachAgent(database.context, workspace.workspace.id, "agent-1");
            await agentDatabaseRows(
                database.database,
                sql`UPDATE happy_agent_module_workspaces
                    SET parent_id = ${workspace.workspace.id}
                    WHERE id = ${workspace.workspace.id}`,
            );

            await expect(workspaces.workspaceForAgent(database.context, "agent-1")).rejects.toThrow(
                "cyclic parent chain",
            );
        } finally {
            database.close();
        }
    });

    it("records lifecycle changes and publishes them transactionally", async () => {
        const changes: string[] = [];
        const { workspaces } = await temporaryWorkspacesCatalog();
        const unsubscribe = workspaces.onEventTransactional((_ctx, event) => {
            changes.push(event.type === "workspace_updated" ? event.change : event.type);
        });
        const database = workspaceDatabase("workspaces-lifecycle-test");
        await database.ready;
        try {
            const { workspace } = await workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            await workspaces.recordInitialization(database.context, {
                workspaceId: workspace.id,
                facts: {
                    baseCommit: "abc123",
                    baseRef: "origin/main",
                    gitCommonDir: "/repo/.git",
                },
            });
            await workspaces.markReady(database.context, { workspaceId: workspace.id });
            await workspaces.setBranch(database.context, {
                workspaceId: workspace.id,
                branch: "worktree/retry-policy-actual",
            });
            const failed = await workspaces.markFailed(database.context, {
                workspaceId: workspace.id,
                error: "The worktree folder disappeared.",
            });

            expect(failed).toMatchObject({
                status: "failed",
                initializationError: "The worktree folder disappeared.",
                version: 5,
            });
            expect(changes).toEqual([
                "workspace_created",
                "record_initialization",
                "mark_ready",
                "set_branch",
                "mark_failed",
            ]);
        } finally {
            unsubscribe();
            database.close();
        }
    });
});
