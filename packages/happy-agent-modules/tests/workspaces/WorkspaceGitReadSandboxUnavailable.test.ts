import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations, type Workspace } from "../../sources/workspaces/index.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    gitRunner,
} from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

afterEach(cleanupRoots);

/**
 * Foreground Git works, but the read-only sandbox cannot start: what a Linux host that restricts
 * unprivileged user namespaces, such as a GitHub Ubuntu 24.04 runner, does to every sandboxed read.
 */
const sandboxUnavailableRunner: GitCommandRunner = {
    run: gitRunner.run,
    scan: async () => {
        throw new Error(
            "Linux sandbox setup failed: mount private procfs: Operation not permitted (os error 1)",
        );
    },
};

it("cuts a Git worktree from a repository when the read-only Git sandbox cannot start", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "src"));
    await commitFile(repository, "src/rename-source.ts", "export const source = 1;\n");
    // The project's own working tree is dirty. A worktree starts from the commit; a copied folder
    // would carry this move along.
    await mkdir(join(repository, "src/renamed"));
    await rename(
        join(repository, "src/rename-source.ts"),
        join(repository, "src/renamed/renamed-source.ts"),
    );

    const git = GitModule.withRunner(sandboxUnavailableRunner);
    const catalog = workspacesCatalogFrom(
        await testConfigRootedAt(await createRoot("workspace-read-sandbox-")),
        git,
    );
    const database = moduleDatabase(
        [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
        "workspace-read-sandbox",
    );
    await database.ready;
    const ctx = database.context;
    try {
        await catalog.start(ctx);
        const agents = catalog.agents.asRef();
        catalog.projects.beforeStart(ctx, agents);
        catalog.workspaces.beforeStart(ctx, agents);
        const project = await catalog.projects.create(ctx, {
            name: "Project",
            repositoryRef: git.normalizeProjectCwd(repository),
        });
        const probed = await catalog.projects.probe(ctx, project.id);
        expect(probed).toMatchObject({ worktreeSupport: "supported" });
        await catalog.projects.markInitializationReady(ctx, project.id);

        const created = await catalog.workspaces.createWorkspace(ctx, project.id, {
            name: "work",
        });
        if (created === undefined) throw new Error("The project was not found.");
        let workspace: Workspace | undefined;
        await vi.waitFor(
            async () => {
                workspace = await catalog.workspaces.get(ctx, created.id);
                if (workspace?.status === "failed") {
                    throw new Error(workspace.initializationError ?? "Initialization failed.");
                }
                expect(workspace?.status).toBe("ready");
            },
            { timeout: 15_000 },
        );
        expect(workspace).toMatchObject({ kind: "git_worktree" });
        const path = workspace?.path ?? "";
        expect(existsSync(join(path, ".git"))).toBe(true);
        expect(existsSync(join(path, "src/rename-source.ts"))).toBe(true);
        expect(existsSync(join(path, "src/renamed"))).toBe(false);
    } finally {
        catalog.durableFunctions.stop();
        await catalog.workspaces.close(ctx);
        git.dispose();
        database.close();
    }
});
