import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations, type Workspace } from "../../sources/workspaces/index.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
} from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

afterEach(cleanupRoots);

describe("archiving a worktree workspace", () => {
    it("saves its uncommitted work to a ref before removing the folder, and purge deletes it", async () => {
        const repository = await createRepository();
        await commitFile(repository, "tracked.txt", "one\n");
        const world = await createWorld("archive-preserves-work");
        try {
            const project = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: world.git.normalizeProjectCwd(repository),
                name: "Project",
            });
            await world.projects.probe(world.database.context, project.id);
            await world.projects.markInitializationReady(world.database.context, project.id);
            const id = createId();
            await world.workspaces.createWorkspace(world.database.context, project.id, {
                id,
                name: "Dirty",
            });
            const ready = await waitForWorkspace(world, id, "ready");
            const head = await git(ready.path, ["rev-parse", "HEAD"]);
            await writeFile(join(ready.path, "tracked.txt"), "two\n");
            await writeFile(join(ready.path, "untracked.txt"), "untracked\n");
            const ref = `refs/happy/archived/${id}`;

            await world.workspaces.archive(world.database.context, id);
            await waitForWorkspace(world, id, "archived");

            expect(existsSync(ready.path)).toBe(false);
            expect(await git(repository, ["rev-parse", `${ref}^`])).toBe(head);
            expect(await git(repository, ["show", `${ref}:tracked.txt`])).toBe("two");
            expect(await git(repository, ["show", `${ref}:untracked.txt`])).toBe("untracked");
            expect(await git(repository, ["rev-parse", ready.branch])).toBe(head);

            await world.workspaces.purge(world.database.context, id);

            await expect(
                git(repository, ["show-ref", "--verify", "--quiet", ref]),
            ).rejects.toThrow();
            await expect(
                git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${ready.branch}`]),
            ).rejects.toThrow();
        } finally {
            await world.close();
        }
    }, 30_000);
});

async function createWorld(name: string) {
    const root = await createRoot(`happy-${name}-`);
    const config = await testConfigRootedAt(root);
    const gitModule = GitModule.withRunner(gitRunner);
    const { durableFunctions, projects, start, workspaces } = workspacesCatalogFrom(
        config,
        gitModule,
    );
    const database = moduleDatabase(
        [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
        `${name}-database`,
    );
    await database.ready;
    await start(database.context);
    return {
        git: gitModule,
        projects,
        workspaces,
        database,
        close: async () => {
            durableFunctions.stop();
            await workspaces.close(database.context);
            database.close();
        },
    };
}

async function waitForWorkspace(
    world: Awaited<ReturnType<typeof createWorld>>,
    workspaceId: string,
    status: Workspace["status"],
): Promise<Workspace> {
    let workspace: Workspace | undefined;
    await vi.waitFor(
        async () => {
            workspace = await world.workspaces.get(world.database.context, workspaceId);
            if (workspace?.status === "failed" && status !== "failed") {
                throw new Error(
                    workspace.initializationError ?? "Workspace initialization failed.",
                );
            }
            expect(workspace?.status).toBe(status);
        },
        { timeout: 15_000 },
    );
    if (workspace === undefined) throw new Error("The workspace was not found.");
    return workspace;
}
