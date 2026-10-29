import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import {
    durableFunctionsMigrations,
    DurableFunctionsModule,
} from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { deleteWorkspaceBranch } from "../../sources/workspaces/impl/deleteWorkspaceBranch.js";
import { workspaceMigrations, WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/** Agents that exist and stop at once; nobody here has a parent or children. */
const agents = {
    config: async () => ({}),
    childOf: async () => [],
    parentOf: async () => null,
    abort: async () => undefined,
} as unknown as AgentSystemRef;

async function catalogs(name: string) {
    const config = await temporaryTestConfig();
    const git = new GitModule();
    const abort = new AbortModule(new ComputeModule(config, new SecretsModule()));
    const durableFunctions = new DurableFunctionsModule();
    const runners = new RunnersModule(config);
    const projects = new ProjectsModule(config, git, abort, durableFunctions, runners);
    const workspaces = new WorkspacesModule(
        config,
        projects,
        git,
        abort,
        durableFunctions,
        runners,
    );
    const database = moduleDatabase(
        [...projectMigrations, ...workspaceMigrations, ...durableFunctionsMigrations],
        name,
    );
    await database.ready;
    abort.beforeStart(database.context, agents);
    const projectHooks = projects.beforeStart(database.context, agents);
    const workspaceHooks = workspaces.beforeStart(database.context, agents);
    const durableHooks = durableFunctions.beforeStart(database.context);
    await durableHooks.afterStart?.(database.context, agents);
    return {
        ctx: database.context,
        close: () => {
            durableFunctions.stop();
            database.close();
        },
        projectHooks,
        projects,
        workspaceHooks,
        workspaces,
    };
}

describe("deleting a workspace for good", () => {
    it("removes an archived workspace's folder, placements, and row, whatever it kept on archive", async () => {
        const world = await catalogs("workspace-purge");
        try {
            const { ctx, workspaces } = world;
            const events: string[] = [];
            workspaces.onEvent((_ctx: Context, event) => {
                events.push(event.type);
            });
            await world.projects.create(ctx, {
                id: "acme",
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await workspaces.reserve(ctx, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Doomed",
                kind: "directory",
            });
            await workspaces.attachAgent(ctx, "workspace-1", "agent-1");
            const path = (await workspaces.get(ctx, "workspace-1"))!.path;
            await expect(workspaces.purge(ctx, "workspace-1")).rejects.toThrow(
                "Only an archived workspace can be deleted.",
            );

            await workspaces.archive(ctx, "workspace-1");
            await vi.waitFor(async () => {
                expect((await workspaces.get(ctx, "workspace-1"))?.status).toBe("archived");
            });
            // As a folder kept on archive would be.
            await mkdir(path, { recursive: true });
            await writeFile(join(path, "notes.txt"), "left behind");

            await workspaces.purge(ctx, "workspace-1");

            expect(await workspaces.get(ctx, "workspace-1")).toBeUndefined();
            expect(await workspaces.listAgentIds(ctx, "workspace-1")).toEqual([]);
            expect(await workspaces.workspaceForAgent(ctx, "agent-1")).toBeUndefined();
            expect(existsSync(path)).toBe(false);
            await vi.waitFor(() => {
                expect(events.at(-1)).toBe("workspace_deleted");
            });
            await workspaces.purge(ctx, "workspace-1");
        } finally {
            world.close();
        }
    });

    it("refuses a workspace whose child workspaces are still there", async () => {
        const world = await catalogs("workspace-purge-children");
        try {
            const { ctx, workspaces } = world;
            await world.projects.create(ctx, {
                id: "acme",
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await workspaces.reserve(ctx, { id: "parent", projectRef: "acme", name: "Parent" });
            await workspaces.reserve(ctx, {
                id: "child",
                projectRef: "acme",
                parentId: "parent",
                name: "Child",
            });
            await workspaces.archive(ctx, "parent");
            await vi.waitFor(async () => {
                expect((await workspaces.get(ctx, "parent"))?.status).toBe("archived");
                expect((await workspaces.get(ctx, "child"))?.status).toBe("archived");
            });
            await expect(workspaces.purge(ctx, "parent")).rejects.toThrow(
                "Delete the workspace's child workspaces before the workspace itself.",
            );
            await workspaces.purge(ctx, "child");
            await workspaces.purge(ctx, "parent");
            expect(await workspaces.get(ctx, "parent")).toBeUndefined();
        } finally {
            world.close();
        }
    });

    it("drops an erased agent's placement in the same transaction", async () => {
        const world = await catalogs("workspace-erased-agent");
        try {
            const { ctx, workspaces } = world;
            await world.projects.create(ctx, {
                id: "acme",
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await workspaces.reserve(ctx, { id: "workspace-1", projectRef: "acme", name: "Kept" });
            await workspaces.attachAgent(ctx, "workspace-1", "agent-1");
            await workspaces.attachAgent(ctx, "workspace-1", "agent-2");
            await ctx.inTx(async (txCtx) => {
                await world.workspaceHooks.agentErasedTransact?.(
                    txCtx,
                    {} as never,
                    {
                        id: "agent-1",
                    } as never,
                );
            });
            expect(await workspaces.listAgentIds(ctx, "workspace-1")).toEqual(["agent-2"]);
        } finally {
            world.close();
        }
    });
});

describe("deleting a project for good", () => {
    it("removes an archived project's rows but never the folder a person registered", async () => {
        const world = await catalogs("project-purge");
        try {
            const { ctx, projects } = world;
            const folder = await mkdtemp(join(tmpdir(), "registered-project-"));
            const events: string[] = [];
            projects.onEvent((_ctx: Context, event) => {
                events.push(event.type);
            });
            const project = await projects.create(ctx, {
                id: "acme",
                name: "Acme",
                repositoryRef: folder,
            });
            await projects.attachAgent(ctx, project.id, "root-agent");
            expect(await projects.managedDirectory(project)).toBeUndefined();
            await expect(projects.purge(ctx, project.id)).rejects.toThrow(
                "Only an archived project can be deleted.",
            );

            await projects.archive(ctx, project.id);
            await projects.purge(ctx, project.id);

            expect(await projects.get(ctx, project.id)).toBeUndefined();
            expect(await projects.listAgentIds(ctx, project.id)).toEqual([]);
            expect(existsSync(folder)).toBe(true);
            await vi.waitFor(() => {
                expect(events.at(-1)).toBe("project_deleted");
            });
            await projects.purge(ctx, project.id);
        } finally {
            world.close();
        }
    });

    it("drops an erased root agent from its project in the same transaction", async () => {
        const world = await catalogs("project-erased-agent");
        try {
            const { ctx, projects } = world;
            await projects.create(ctx, {
                id: "acme",
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await projects.attachAgent(ctx, "acme", "agent-1");
            await projects.attachAgent(ctx, "acme", "agent-2");
            await ctx.inTx(async (txCtx) => {
                await world.projectHooks.agentErasedTransact?.(
                    txCtx,
                    {} as never,
                    {
                        id: "agent-1",
                    } as never,
                );
            });
            expect(await projects.listAgentIds(ctx, "acme")).toEqual(["agent-2"]);
        } finally {
            world.close();
        }
    });
});

describe("deleting a worktree's branch", () => {
    it("deletes the branch once its worktree is gone, and accepts one already deleted", async () => {
        const root = await mkdtemp(join(tmpdir(), "workspace-branch-"));
        const repository = join(root, "repository");
        const git = (cwd: string, ...args: string[]) =>
            execFileSync("git", args, {
                cwd,
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "Test",
                    GIT_AUTHOR_EMAIL: "test@example.com",
                    GIT_COMMITTER_NAME: "Test",
                    GIT_COMMITTER_EMAIL: "test@example.com",
                },
            }).toString();
        await mkdir(repository);
        git(repository, "init", "--quiet", "--initial-branch=main");
        await writeFile(join(repository, "README.md"), "hello\n");
        git(repository, "add", ".");
        git(repository, "commit", "--quiet", "-m", "initial");
        git(repository, "worktree", "add", "--quiet", "-b", "worktree/doomed", join(root, "wt"));
        await writeFile(join(root, "wt", "change.txt"), "unmerged\n");
        git(join(root, "wt"), "add", ".");
        git(join(root, "wt"), "commit", "--quiet", "-m", "unmerged work");

        const module = new GitModule();
        // Git refuses while a worktree still has the branch checked out.
        await expect(
            deleteWorkspaceBranch({
                branch: "worktree/doomed",
                git: module,
                projectPath: repository,
            }),
        ).rejects.toThrow('Git could not delete the branch "worktree/doomed"');

        git(repository, "worktree", "remove", "--force", join(root, "wt"));
        await deleteWorkspaceBranch({
            branch: "worktree/doomed",
            git: module,
            projectPath: repository,
        });
        expect(git(repository, "branch", "--list", "worktree/doomed")).toBe("");
        await deleteWorkspaceBranch({
            branch: "worktree/doomed",
            git: module,
            projectPath: repository,
        });
    });
});
