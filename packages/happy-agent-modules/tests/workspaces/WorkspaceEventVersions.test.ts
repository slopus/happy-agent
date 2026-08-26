import { describe, expect, it } from "vitest";

import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import {
    type WorkspaceEvent,
    WorkspacesModule,
    workspaceMigrations,
} from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { temporaryWorkspacesCatalog } from "../support/workspacesModule.js";

describe("workspace lifecycle event versions", () => {
    it("carries the exact preceding workspace through sequential updates", async () => {
        const database = moduleDatabase(workspaceMigrations, "workspace-event-version-chain");
        await database.ready;
        try {
            const { workspaces } = await temporaryWorkspacesCatalog();
            const events: WorkspaceEvent[] = [];
            workspaces.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const reserved = await workspaces.reserve(database.context, {
                id: "workspace-event-version-chain",
                projectRef: "project-event-version-chain",
                name: "Version chain",
            });
            const branched = await workspaces.setBranch(database.context, {
                branch: "worktree/version-chain-renamed",
                workspaceId: reserved.workspace.id,
            });
            const initialized = await workspaces.recordInitialization(database.context, {
                facts: {
                    baseCommit: "abc123",
                    baseRef: "origin/main",
                    gitCommonDir: "/tmp/projects/event-version-chain/.git",
                },
                workspaceId: reserved.workspace.id,
            });
            const ready = await workspaces.markReady(database.context, {
                workspaceId: reserved.workspace.id,
            });

            expect(events.map((event) => event.type)).toEqual([
                "workspace_created",
                "workspace_updated",
                "workspace_updated",
                "workspace_updated",
            ]);
            expect(events[0]).toMatchObject({ workspace: reserved.workspace });
            expectWorkspaceUpdateChain(events[1]!, reserved.workspace, branched);
            expectWorkspaceUpdateChain(events[2]!, branched, initialized);
            expectWorkspaceUpdateChain(events[3]!, initialized, ready);
        } finally {
            database.close();
        }
    });

    it("versions and announces every durable top-level-agent catalog change", async () => {
        const database = moduleDatabase(workspaceMigrations, "workspace-agent-event-version-chain");
        await database.ready;
        try {
            const { abort, config, git, projects, workspaces } = await temporaryWorkspacesCatalog();
            workspaces.beforeStart(database.context, {
                parentOf: async () => null,
            } as never);
            const events: WorkspaceEvent[] = [];
            workspaces.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const first = await workspaces.reserve(database.context, {
                id: "workspace-agent-event-first",
                projectRef: "workspace-agent-event-project",
                name: "First",
            });
            const second = await workspaces.reserve(database.context, {
                id: "workspace-agent-event-second",
                projectRef: "workspace-agent-event-project",
                name: "Second",
            });
            await workspaces.attachAgent(database.context, first.workspace.id, "agent-one");
            const firstAttached = await requiredWorkspace(
                workspaces,
                database.context,
                first.workspace.id,
            );
            await workspaces.attachAgent(database.context, first.workspace.id, "agent-one");
            expect(
                await requiredWorkspace(workspaces, database.context, first.workspace.id),
            ).toEqual(firstAttached);

            await workspaces.attachAgent(database.context, first.workspace.id, "agent-two");
            const secondAttached = await requiredWorkspace(
                workspaces,
                database.context,
                first.workspace.id,
            );
            await workspaces.reorderAgent(database.context, first.workspace.id, "agent-two", null);
            const reordered = await requiredWorkspace(
                workspaces,
                database.context,
                first.workspace.id,
            );
            await expect(
                workspaces.attachAgent(database.context, second.workspace.id, "agent-one"),
            ).rejects.toThrow(/already attached to workspace/);

            expect(events.map((event) => event.type)).toEqual([
                "workspace_created",
                "workspace_created",
                "workspace_agent_attached",
                "workspace_agent_attached",
                "workspace_agent_reordered",
            ]);
            expectWorkspaceUpdateChain(events[2]!, first.workspace, firstAttached);
            expectWorkspaceUpdateChain(events[3]!, firstAttached, secondAttached);
            expectWorkspaceUpdateChain(events[4]!, secondAttached, reordered);

            const restarted = new WorkspacesModule(
                config,
                projects,
                git,
                abort,
                new DurableFunctionsModule(),
            );
            expect(await restarted.get(database.context, first.workspace.id)).toEqual(reordered);
            expect(await restarted.get(database.context, second.workspace.id)).toEqual(
                second.workspace,
            );
            expect(await restarted.listAgentIds(database.context, first.workspace.id)).toEqual([
                "agent-two",
                "agent-one",
            ]);
            expect(await restarted.listAgentIds(database.context, second.workspace.id)).toEqual([]);
        } finally {
            database.close();
        }
    });
});

async function requiredWorkspace(
    workspaces: Awaited<ReturnType<typeof temporaryWorkspacesCatalog>>["workspaces"],
    ctx: Parameters<Awaited<ReturnType<typeof temporaryWorkspacesCatalog>>["workspaces"]["get"]>[0],
    workspaceId: string,
) {
    const workspace = await workspaces.get(ctx, workspaceId);
    if (workspace === undefined) throw new Error("The workspace disappeared.");
    return workspace;
}

function expectWorkspaceUpdateChain(
    event: WorkspaceEvent,
    previousWorkspace: { readonly version: number },
    workspace: { readonly version: number },
): void {
    expect(event).toHaveProperty("previousWorkspace");
    expect(event).toHaveProperty("workspace");
    if (!("previousWorkspace" in event) || !("workspace" in event)) {
        throw new Error("Expected a workspace lifecycle update event.");
    }
    expect(event.previousWorkspace).toEqual(previousWorkspace);
    expect(event.workspace).toEqual(workspace);
    expect(event.previousWorkspace.version).toBe(workspace.version - 1);
}
