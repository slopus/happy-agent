import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import { validateRegistrationPath } from "../../sources/projects/impl/validateRegistrationPath.js";
import {
    workspaceMigrations,
    type Workspace,
    type WorkspacesModule,
} from "../../sources/workspaces/index.js";
import { cleanupRoots, createRepository, gitRunner } from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsCatalogFor, projectsModuleFor } from "../support/projectsModule.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

afterEach(cleanupRoots);

describe("plain-directory project registration", () => {
    it("recovers durable project provisioning without a project startup sweep", async () => {
        const root = await mkdtemp(join(tmpdir(), "project-provision-recovery-"));
        const folder = join(root, "source");
        await mkdir(folder);
        const world = await createWorld(root, "project-provision-recovery");
        let restarted: ReturnType<typeof projectsCatalogFor> | undefined;
        try {
            const project = await world.projects.register(world.database.context, {
                path: folder,
            });
            world.durableFunctions.stop();

            restarted = projectsCatalogFor(world.config, world.git);
            const hooks = restarted.durableFunctions.beforeStart(world.database.context);
            restarted.projects.beforeStart(world.database.context, restarted.agents.asRef());
            restarted.projects.open("test-instance");
            await hooks.afterStart?.(world.database.context, restarted.agents.asRef());

            const ready = await waitForProject(
                restarted.projects,
                world.database.context,
                project.id,
            );
            expect(ready.initializationStatus).toBe("ready");
            expect(ready.presence).toBe("present");
        } finally {
            restarted?.durableFunctions.stop();
            await world.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("removes only the exact managed remote-project root after archival", async () => {
        const root = await mkdtemp(join(tmpdir(), "managed-project-archive-"));
        const world = await createWorld(root, "managed-project-archive");
        try {
            const managed = join(world.config.projectsHome, "managed-project");
            await mkdir(managed, { recursive: true });
            await writeFile(join(managed, "owned.txt"), "owned\n", "utf8");
            const project = await world.projects.create(world.database.context, {
                id: "managed-project",
                name: "Managed project",
                repositoryRef: world.git.normalizeProjectCwd(managed),
                remoteSource: { kind: "git", url: "https://example.com/managed-project.git" },
            });

            await world.projects.archive(world.database.context, project.id);
            await vi.waitFor(() => {
                expect(existsSync(managed)).toBe(false);
            });
        } finally {
            await world.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("persists non-Git facts and creates copied child workspaces after restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "plain-project-registration-"));
        const folder = join(root, "source");
        await mkdir(folder);
        await writeFile(join(folder, "project.txt"), "plain directory\n", "utf8");
        const world = await createWorld(root, "plain-directory");
        let reopened: ProjectsModule | undefined;
        try {
            const registered = await world.projects.register(world.database.context, {
                path: folder,
            });
            expect(registered.id).toMatch(/^[a-z][a-z0-9]{23}$/);
            expect(registered.repositoryRef).toBe(world.git.normalizeProjectCwd(folder));

            const ready = await waitForProject(
                world.projects,
                world.database.context,
                registered.id,
            );
            expect(ready).toMatchObject({
                gitAhead: 0,
                gitBehind: 0,
                gitDetached: false,
                initializationStatus: "ready",
                presence: "present",
                worktreeSupport: "unsupported",
                worktreeUnsupportedReason: "This folder is not a Git repository.",
            });
            expect(ready).not.toHaveProperty("defaultBranch");
            expect(ready).not.toHaveProperty("gitBranch");
            expect(ready).not.toHaveProperty("gitHead");
            expect(ready).not.toHaveProperty("gitUpstream");

            reopened = projectsModuleFor(world.config, world.git);
            await expect(reopened.get(world.database.context, registered.id)).resolves.toEqual(
                ready,
            );

            const workspaceId = createId();
            const reserved = await world.workspaces.createWorkspace(
                world.database.context,
                registered.id,
                { id: workspaceId, name: "Copied child" },
            );
            expect(reserved).toMatchObject({
                id: workspaceId,
                kind: "directory",
                parentId: registered.id,
                status: "initializing",
            });
            const workspace = await waitForWorkspace(
                world.workspaces,
                world.database.context,
                workspaceId,
            );
            expect(workspace.kind).toBe("directory");
            await expect(readFile(join(workspace.path, "project.txt"), "utf8")).resolves.toBe(
                "plain directory\n",
            );
        } finally {
            await world.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("accepts a Git subdirectory as its own project folder", async () => {
        const repository = await createRepository();
        const subdirectory = join(repository, "packages", "child");
        await mkdir(subdirectory, { recursive: true });
        const root = await mkdtemp(join(tmpdir(), "git-subdirectory-registration-"));
        const world = await createWorld(root, "git-subdirectory");
        try {
            const registered = await world.projects.register(world.database.context, {
                path: subdirectory,
            });
            const ready = await waitForProject(
                world.projects,
                world.database.context,
                registered.id,
            );
            expect(ready).toMatchObject({
                initializationStatus: "ready",
                repositoryRef: world.git.normalizeProjectCwd(subdirectory),
                worktreeSupport: "unsupported",
                worktreeUnsupportedReason:
                    "This folder is inside a Git repository but is not its root.",
            });
        } finally {
            await world.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("does not inspect Git when the selected folder has invalid Git metadata", async () => {
        const root = await mkdtemp(join(tmpdir(), "plain-project-validation-"));
        const folder = join(root, "plain");
        await mkdir(folder);
        await writeFile(join(folder, ".git"), "invalid Git metadata\n", "utf8");
        const topLevel = vi.fn(() =>
            Promise.reject(Object.assign(new Error("Operation not permitted."), { code: 1 })),
        );
        const git = {
            normalizeProjectCwd: () => folder,
            topLevel,
        };
        try {
            await expect(validateRegistrationPath(git, folder)).resolves.toBe(folder);
            expect(topLevel).not.toHaveBeenCalled();
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it("keeps missing, inaccessible, and non-directory paths as registration errors", async () => {
        const root = await mkdtemp(join(tmpdir(), "invalid-directory-registration-"));
        const file = join(root, "file.txt");
        const inaccessible = join(root, "inaccessible");
        await writeFile(file, "not a directory\n", "utf8");
        await mkdir(inaccessible);
        await chmod(inaccessible, 0o000);
        const world = await createWorld(root, "invalid-directory");
        try {
            await expect(
                world.projects.register(world.database.context, {
                    path: join(root, "missing"),
                }),
            ).rejects.toMatchObject({ code: "path_missing" });
            await expect(
                world.projects.register(world.database.context, { path: file }),
            ).rejects.toMatchObject({ code: "not_directory" });
            await expect(
                world.projects.register(world.database.context, { path: inaccessible }),
            ).rejects.toMatchObject({ code: "path_inaccessible" });
        } finally {
            await world.close();
            await chmod(inaccessible, 0o755);
            await rm(root, { force: true, recursive: true });
        }
    });
});

async function createWorld(root: string, name: string) {
    const config = await testConfigRootedAt(join(root, "state"));
    const git = GitModule.withRunner(gitRunner);
    const { durableFunctions, projects, start, workspaces } = workspacesCatalogFrom(config, git);
    const database = moduleDatabase(
        [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
        `${name}-database`,
    );
    await database.ready;
    await start(database.context);
    return {
        config,
        database,
        durableFunctions,
        git,
        projects,
        workspaces,
        close: async () => {
            durableFunctions.stop();
            await workspaces.close(database.context);
            database.close();
        },
    };
}

async function waitForProject(
    projects: ProjectsModule,
    ctx: Parameters<ProjectsModule["get"]>[0],
    projectId: string,
) {
    let project: Awaited<ReturnType<ProjectsModule["get"]>>;
    await vi.waitFor(
        async () => {
            project = await projects.get(ctx, projectId);
            if (project?.initializationStatus === "failed") {
                throw new Error(project.initializationError ?? "Project initialization failed.");
            }
            expect(project?.initializationStatus).toBe("ready");
        },
        { timeout: 15_000 },
    );
    if (project === undefined) throw new Error("The project was not found.");
    return project;
}

async function waitForWorkspace(
    workspaces: WorkspacesModule,
    ctx: Parameters<WorkspacesModule["get"]>[0],
    workspaceId: string,
): Promise<Workspace> {
    let workspace: Workspace | undefined;
    await vi.waitFor(
        async () => {
            workspace = await workspaces.get(ctx, workspaceId);
            if (workspace?.status === "failed") {
                throw new Error(
                    workspace.initializationError ?? "Workspace initialization failed.",
                );
            }
            expect(workspace?.status).toBe("ready");
        },
        { timeout: 15_000 },
    );
    if (workspace === undefined) throw new Error("The workspace was not found.");
    return workspace;
}
