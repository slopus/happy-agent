import { describe, expect, it } from "vitest";

import {
    DurableFunctionsModule,
    durableFunctionsMigrations,
} from "../../sources/durableFunctions/index.js";
import {
    type WorkspaceEvent,
    WorkspacesModule,
    workspaceMigrations,
} from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { temporaryWorkspacesCatalog } from "../support/workspacesModule.js";

describe("a workspace's chosen comparison branch", () => {
    it("is versioned, announced, kept through other changes, and read back after a restart", async () => {
        const database = moduleDatabase(
            [...durableFunctionsMigrations, ...workspaceMigrations],
            "workspace-comparison-base",
        );
        await database.ready;
        try {
            const { abort, config, durableFunctions, git, projects, runners, workspaces } =
                await temporaryWorkspacesCatalog();
            durableFunctions.beforeStart(database.context);
            const events: WorkspaceEvent[] = [];
            workspaces.onEventTransactional((_ctx, event) => {
                events.push(event);
            });
            const { workspace: reserved } = await workspaces.reserve(database.context, {
                id: "workspace-comparison",
                projectRef: "project-comparison",
                name: "Comparison",
            });
            const workspaceId = reserved.id;

            const chosen = await workspaces.setComparisonBase(database.context, {
                workspaceId,
                comparisonBase: "release-v8.8",
                expectedVersion: reserved.version,
            });
            expect(chosen).toMatchObject({
                comparisonBase: "release-v8.8",
                version: reserved.version + 1,
            });
            expect(await workspaces.get(database.context, workspaceId)).toEqual(chosen);
            expect(events.at(-1)).toMatchObject({
                type: "workspace_updated",
                change: "set_comparison_base",
                previousWorkspace: reserved,
                workspace: chosen,
            });

            // Choosing the same branch again is not a change.
            const announced = events.length;
            expect(
                await workspaces.setComparisonBase(database.context, {
                    workspaceId,
                    comparisonBase: "release-v8.8",
                }),
            ).toEqual(chosen);
            expect(events).toHaveLength(announced);

            await expect(
                workspaces.setComparisonBase(database.context, {
                    workspaceId,
                    comparisonBase: "main",
                    expectedVersion: reserved.version,
                }),
            ).rejects.toThrow(/changed before its comparison branch could be chosen/);
            for (const refused of ["", "-main", "release v8.8", "release\tv8.8", "x".repeat(201)]) {
                await expect(
                    workspaces.setComparisonBase(database.context, {
                        workspaceId,
                        comparisonBase: refused,
                    }),
                ).rejects.toThrow();
            }

            // Every other change to the row keeps the choice.
            const branched = await workspaces.setBranch(database.context, {
                workspaceId,
                branch: "worktree/comparison-renamed",
            });
            expect(branched).toMatchObject({
                branch: "worktree/comparison-renamed",
                comparisonBase: "release-v8.8",
            });

            const restartedFunctions = new DurableFunctionsModule();
            restartedFunctions.beforeStart(database.context);
            const restarted = new WorkspacesModule(
                config,
                projects,
                git,
                abort,
                restartedFunctions,
                runners,
            );
            expect(await restarted.get(database.context, workspaceId)).toEqual(branched);
            expect(
                await restarted.listCatalogPage(database.context, {
                    projectRef: "project-comparison",
                }),
            ).toMatchObject({ workspaces: [branched] });

            const automatic = await restarted.setComparisonBase(database.context, {
                workspaceId,
                comparisonBase: null,
            });
            expect(automatic.comparisonBase).toBeUndefined();
            expect(automatic.version).toBe(branched.version + 1);
            expect(await workspaces.get(database.context, workspaceId)).toEqual(automatic);
        } finally {
            database.close();
        }
    });

    it("rolls the choice back with the transaction that carried it", async () => {
        const database = moduleDatabase(
            [...durableFunctionsMigrations, ...workspaceMigrations],
            "workspace-comparison-base-rollback",
        );
        await database.ready;
        try {
            const { durableFunctions, workspaces } = await temporaryWorkspacesCatalog();
            durableFunctions.beforeStart(database.context);
            const { workspace } = await workspaces.reserve(database.context, {
                id: "workspace-comparison-rollback",
                projectRef: "project-comparison-rollback",
                name: "Rollback",
            });

            await expect(
                database.context.inTx(async (txCtx) => {
                    await workspaces.setComparisonBase(txCtx, {
                        workspaceId: workspace.id,
                        comparisonBase: "release-v8.8",
                    });
                    throw new Error("The caller's change failed.");
                }),
            ).rejects.toThrow("The caller's change failed.");
            expect(await workspaces.get(database.context, workspace.id)).toEqual(workspace);
        } finally {
            database.close();
        }
    });
});
