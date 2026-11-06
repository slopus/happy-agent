import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { GitModule, type GitChangeSnapshot } from "../../sources/git/index.js";
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

describe("live Git of a workspace watched before its checkout", () => {
    it("reports edits promptly once the worktree lands", async () => {
        const repository = await createRepository();
        await commitFile(repository, "tracked.txt", "one\n");
        const root = await createRoot("happy-workspace-live-git-");
        const git = GitModule.withRunner(gitRunner);
        const { durableFunctions, projects, start, workspaces } = workspacesCatalogFrom(
            await testConfigRootedAt(root),
            git,
        );
        const database = moduleDatabase(
            [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
            "workspace-live-git-before-checkout",
        );
        await database.ready;
        await start(database.context);
        const workspaceId = createId();
        const published: GitChangeSnapshot[] = [];
        git.onSnapshot((_ctx, entity, snapshot) => {
            if (entity.workspaceId === workspaceId) published.push(snapshot);
        });
        try {
            const project = await projects.create(database.context, {
                id: "project-a",
                repositoryRef: git.normalizeProjectCwd(repository),
                name: "Project",
            });
            await projects.probe(database.context, project.id);
            const readyRoot = await projects.markInitializationReady(database.context, project.id);
            expect(readyRoot.worktreeSupport).toBe("supported");

            // A client watches the workspace as soon as it is announced, while provisioning has
            // not made its folder yet, and the tracker has already scanned the missing folder.
            const reserved = await database.context.inTx(async (txCtx) => {
                const workspace = await workspaces.createWorkspace(txCtx, project.id, {
                    id: workspaceId,
                    name: "Workspace",
                });
                if (workspace === undefined) throw new Error("The project was not found.");
                git.track({
                    path: workspace.path,
                    projectId: project.id,
                    workspaceId: workspace.id,
                });
                await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 5_000 });
                return workspace;
            });
            expect(reserved.status).toBe("initializing");

            let ready: Workspace | undefined;
            await vi.waitFor(
                async () => {
                    ready = await workspaces.get(database.context, reserved.id);
                    expect(ready?.status).toBe("ready");
                },
                { timeout: 15_000 },
            );
            // The checkout is reported, clean, before anything is edited in it.
            await vi.waitFor(
                () =>
                    expect(published.at(-1)).toMatchObject({
                        changedFiles: 0,
                        facts: { branch: ready?.branch },
                    }),
                { timeout: 5_000 },
            );
            expect(published[0]?.error).toBeDefined();
            expect(published.at(-1)?.error).toBeUndefined();

            await writeFile(join(reserved.path, "tracked.txt"), "two\n");

            // Well inside the thirty-second stale check a folder without watches would wait for.
            await vi.waitFor(
                () =>
                    expect(published.at(-1)?.files.map((file) => file.path)).toEqual([
                        "tracked.txt",
                    ]),
                { timeout: 5_000 },
            );
        } finally {
            durableFunctions.stop();
            await workspaces.close(database.context);
            database.close();
        }
    }, 30_000);
});
