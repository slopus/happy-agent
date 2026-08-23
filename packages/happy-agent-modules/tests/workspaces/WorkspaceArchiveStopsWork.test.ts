import type { AgentSystemRef } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import { archiveWorkspaceTool } from "../../sources/workspaces/tools/archive_workspace.js";
import { workspaceMigrations, WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/**
 * The collection an abort reaches, recording what it was asked to cancel and when.
 *
 * Aborts are registered on the archival's own transaction, so an abort observed here before the
 * commit would prove nothing about durability. Every identity is recorded from `afterCommit`,
 * which means the list holds exactly the cancellations that became real together with the
 * archival record.
 */
class RecordingCollection {
    readonly aborted: string[] = [];
    readonly children = new Map<string, readonly string[]>();
    failingAgentId: string | undefined;

    async childOf(_ctx: Context, agentId: string): Promise<readonly string[]> {
        return this.children.get(agentId) ?? [];
    }

    /** Every agent a test attaches is a person's own conversation rather than a subagent. */
    async parentOf(): Promise<string | null> {
        return null;
    }

    async abort(ctx: Context, agentId: string): Promise<void> {
        if (agentId === this.failingAgentId) throw new Error("The agent could not be cancelled.");
        afterCommit(ctx, () => {
            this.aborted.push(agentId);
        });
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

/**
 * Two catalogs whose aborts are observable, built the way the composition root builds them.
 *
 * The one abort module is shared, because that is the arrangement being tested: a project and its
 * workspaces hold two separate lists of agents, and archiving a project has to reach both of them
 * without reaching either identity twice.
 */
async function archivingCatalog(name: string) {
    const config = await temporaryTestConfig();
    const git = new GitModule();
    const abort = new AbortModule(new ComputeModule(config));
    const projects = new ProjectsModule(config, git, abort);
    const workspaces = new WorkspacesModule(config, projects, git, abort);
    const collection = new RecordingCollection();
    const database = moduleDatabase([], name);
    await database.ready;
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of workspaceMigrations) {
        await migrate(database.context, database.database);
    }
    abort.beforeStart(database.context, collection.asRef());
    projects.beforeStart(database.context, collection.asRef());
    workspaces.beforeStart(database.context, collection.asRef());
    return { collection, ctx: database.context, database, projects, workspaces };
}

/** One invocation, as the agent hands it to a tool. Only its identity is used here. */
function toolCall() {
    return {
        id: "call-1",
        providerCallId: "provider-call-1",
        kv: undefined,
        commit: async (_ctx: Context, result: unknown) => result,
    } as unknown as Parameters<ReturnType<typeof archiveWorkspaceTool>["execute"]>[2];
}

describe("archiving stops the work standing in a workspace", () => {
    it("cancels every agent in the workspace it archives, and only that workspace", async () => {
        const world = await archivingCatalog("workspace-archive-aborts-agents");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed workspace",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-2",
                projectRef: "acme",
                name: "Untouched workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-2");
            await world.workspaces.attachAgent(world.ctx, "workspace-2", "agent-3");

            const archived = await world.workspaces.beginArchive(world.ctx, "workspace-1");

            expect(archived.status).toBe("archiving");
            expect(world.collection.aborted).toEqual(["agent-1", "agent-2"]);
        } finally {
            world.database.close();
        }
    });

    it("carries the subagent tree below an agent it cancels", async () => {
        const world = await archivingCatalog("workspace-archive-aborts-subagents");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");
            world.collection.children.set("agent-1", ["helper-1"]);
            world.collection.children.set("helper-1", ["helper-2"]);

            await world.workspaces.beginArchive(world.ctx, "workspace-1");

            // Leaf first, exactly as the abort module orders a chain.
            expect(world.collection.aborted).toEqual(["helper-2", "helper-1", "agent-1"]);
        } finally {
            world.database.close();
        }
    });

    it("cancels the agents of every workspace when the project is archived", async () => {
        const world = await archivingCatalog("project-archive-aborts-agents");
        try {
            const project = await world.projects.create(world.ctx, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: project.id,
                name: "First workspace",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-2",
                projectRef: project.id,
                name: "Second workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");
            await world.workspaces.attachAgent(world.ctx, "workspace-2", "agent-2");

            await world.projects.archive(world.ctx, project.id);

            expect([...world.collection.aborted].sort()).toEqual(["agent-1", "agent-2"]);
        } finally {
            world.database.close();
        }
    });

    it("cancels the project's own agents as well as its workspaces'", async () => {
        const world = await archivingCatalog("project-archive-aborts-root-agents");
        try {
            const project = await world.projects.create(world.ctx, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: project.id,
                name: "First workspace",
            });
            // An agent working in the project's own checkout, and one in a workspace cut from it.
            // These are two separate attachments; neither catalog can see the other's.
            await world.projects.attachAgent(world.ctx, project.id, "root-agent");
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "workspace-agent");

            await world.projects.archive(world.ctx, project.id);

            expect([...world.collection.aborted].sort()).toEqual(["root-agent", "workspace-agent"]);
        } finally {
            world.database.close();
        }
    });

    it("cancels an agent once when the same archival reaches it twice", async () => {
        const world = await archivingCatalog("project-archive-cancels-once");
        try {
            const project = await world.projects.create(world.ctx, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: project.id,
                name: "First workspace",
            });
            // A subagent of the project's root agent that is itself standing in a workspace of that
            // project. Archiving reaches it down the root's chain and again through the workspace.
            await world.projects.attachAgent(world.ctx, project.id, "root-agent");
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "helper");
            world.collection.children.set("root-agent", ["helper"]);

            await world.projects.archive(world.ctx, project.id);

            expect(world.collection.aborted).toEqual(["helper", "root-agent"]);
        } finally {
            world.database.close();
        }
    });

    it("refuses to attach an agent to a workspace that is going away", async () => {
        const world = await archivingCatalog("workspace-attach-after-archive");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed workspace",
            });

            await world.workspaces.beginArchive(world.ctx, "workspace-1");

            // Archiving cancels the agents it can see. An agent arriving immediately afterwards is
            // one the archival has already scanned past, so it would run on in a folder about to be
            // deleted with nothing left to stop it. The attachment has to lose instead.
            await expect(
                world.workspaces.attachAgent(world.ctx, "workspace-1", "late-agent"),
            ).rejects.toThrow(/archiv/iu);
            expect(await world.workspaces.listAgentIds(world.ctx, "workspace-1")).toEqual([]);
        } finally {
            world.database.close();
        }
    });

    it("refuses to attach a root agent to a project that is going away", async () => {
        const world = await archivingCatalog("project-attach-after-archive");
        try {
            const project = await world.projects.create(world.ctx, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });

            await world.projects.archive(world.ctx, project.id);

            await expect(
                world.projects.attachAgent(world.ctx, project.id, "late-agent"),
            ).rejects.toThrow(/archiv/iu);
            expect(await world.projects.listAgentIds(world.ctx, project.id)).toEqual([]);
        } finally {
            world.database.close();
        }
    });

    it("does not reach into agents again when an archived workspace is archived once more", async () => {
        const world = await archivingCatalog("workspace-archive-is-idempotent");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");

            await world.workspaces.beginArchive(world.ctx, "workspace-1");
            await world.workspaces.beginArchive(world.ctx, "workspace-1");

            expect(world.collection.aborted).toEqual(["agent-1"]);
        } finally {
            world.database.close();
        }
    });

    it("cancels the agent that archived the workspace it was itself working in", async () => {
        const world = await archivingCatalog("workspace-archive-cancels-the-archiver");
        try {
            const project = await world.projects.create(world.ctx, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: project.id,
                name: "Its own workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");

            // Called through rather than replaced. Cleanup runs after the transaction has ended, so
            // it has to reach a live database — the whole point of the lifetime being taken at
            // startup instead of from whichever caller happened to ask first.
            const removeArchived = world.workspaces.removeArchivedWorkspace.bind(world.workspaces);
            const cleanupDatabases: unknown[] = [];
            const removals = vi
                .spyOn(world.workspaces, "removeArchivedWorkspace")
                .mockImplementation(async (cleanupCtx, projectId, workspaceId) => {
                    cleanupDatabases.push(cleanupCtx.db);
                    return await removeArchived(cleanupCtx, projectId, workspaceId);
                });

            // The `archive_workspace` tool is transactional, so this is the agent's own storage
            // transaction, and the cancellation lands when the tool's result commits with it.
            const tool = archiveWorkspaceTool(world.workspaces, "agent-1");
            await world.ctx.inTx(async (txCtx) => {
                await tool.execute(txCtx, { workspaceId: "workspace-1" }, toolCall());
                // Still inside the transaction: nothing has been signalled and no folder has been
                // handed to cleanup while the turn could still fail.
                expect(world.collection.aborted).toEqual([]);
                expect(removals).not.toHaveBeenCalled();
            });

            // The archiver is not exempt. Its checkout is being deleted, and an agent left running
            // in a deleted checkout is the bug this whole change exists to prevent.
            expect(world.collection.aborted).toEqual(["agent-1"]);
            await world.workspaces.whenCleanupSettles();
            expect(removals).toHaveBeenCalledWith(expect.anything(), project.id, "workspace-1");
            // Cleanup reached the catalog's own database, not the tool transaction's dead facade,
            // and got far enough to finish the archival it was scheduled for.
            expect(cleanupDatabases).toEqual([world.ctx.db]);
            expect((await world.workspaces.get(world.ctx, "workspace-1"))?.status).toBe("archived");
        } finally {
            world.database.close();
        }
    });

    it("stops nothing when the turn that archived the workspace rolls back", async () => {
        const world = await archivingCatalog("workspace-archive-rolls-back-with-the-turn");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Its own workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");

            const removals = vi
                .spyOn(world.workspaces, "removeArchivedWorkspace")
                .mockResolvedValue(undefined);

            const tool = archiveWorkspaceTool(world.workspaces, "agent-1");
            await expect(
                world.ctx.inTx(async (txCtx) => {
                    await tool.execute(txCtx, { workspaceId: "workspace-1" }, toolCall());
                    // Whatever else the turn was doing fails after the tool ran.
                    throw new Error("The turn could not record its result.");
                }),
            ).rejects.toThrow("The turn could not record its result.");

            // The archival never happened, so neither did anything that follows from it: no agent
            // was cancelled, and the checkout the workspace still has was never deleted.
            expect(world.collection.aborted).toEqual([]);
            await world.workspaces.whenCleanupSettles();
            expect(removals).not.toHaveBeenCalled();
            expect((await world.workspaces.get(world.ctx, "workspace-1"))?.status).not.toBe(
                "archiving",
            );
        } finally {
            world.database.close();
        }
    });

    it("keeps the workspace active when the work in it could not be stopped", async () => {
        const world = await archivingCatalog("workspace-archive-is-atomic");
        try {
            await world.workspaces.reserve(world.ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed workspace",
            });
            await world.workspaces.attachAgent(world.ctx, "workspace-1", "agent-1");
            world.collection.failingAgentId = "agent-1";

            await expect(world.workspaces.beginArchive(world.ctx, "workspace-1")).rejects.toThrow(
                "The agent could not be cancelled.",
            );

            // Archival and cancellation are one decision: neither half may survive alone.
            expect(world.collection.aborted).toEqual([]);
            expect((await world.workspaces.get(world.ctx, "workspace-1"))?.status).not.toBe(
                "archiving",
            );
        } finally {
            world.database.close();
        }
    });
});
