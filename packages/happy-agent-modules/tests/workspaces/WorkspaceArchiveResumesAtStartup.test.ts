import { describe, expect, it, vi } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations, type WorkspaceEvent } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

describe("durable workspace archive recovery", () => {
    it("recovers the pending archive call without a workspace startup sweep", async () => {
        const config = await temporaryTestConfig();
        const database = moduleDatabase([], "stranded-archival-recovery");
        await database.ready;
        for (const [, migrate] of projectMigrations) {
            await migrate(database.context, database.database);
        }
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
        for (const [, migrate] of durableFunctionsMigrations) {
            await migrate(database.context, database.database);
        }
        try {
            // Stop dispatch before its next-turn launch. The lifecycle row and pending call have
            // committed together, but no executor has had a chance to remove the folder.
            const first = workspacesCatalogFrom(config);
            await first.start(database.context);
            const project = await first.projects.create(database.context, {
                id: "acme",
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await first.workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: project.id,
                name: "Interrupted workspace",
                kind: "directory",
            });
            await first.workspaces.archive(database.context, "workspace-1");
            first.durableFunctions.stop();
            const stranded = await first.workspaces.get(database.context, "workspace-1");
            expect(stranded?.status).toBe("archiving");

            // A new Durable Functions instance recovers the call. Workspaces.open is intentionally
            // absent here: there is no catalog sweep involved in the repair.
            const second = workspacesCatalogFrom(config);
            const events: WorkspaceEvent[] = [];
            second.workspaces.onEvent((_ctx, event) => {
                events.push(event);
            });
            await second.start(database.context);
            await expectArchived(second, database.context, "workspace-1");

            const recovered = await second.workspaces.get(database.context, "workspace-1");
            expect(recovered?.status).toBe("archived");
            expect(
                events.some(
                    (event) =>
                        event.type === "workspace_archived" && event.workspace.id === "workspace-1",
                ),
            ).toBe(true);

            // Recovery is a repair, not a new decision, and a third run finds no pending work.
            expect(second.agents.aborted).toEqual([]);
            second.durableFunctions.stop();
            const third = workspacesCatalogFrom(config);
            await third.start(database.context);
            await expectArchived(third, database.context, "workspace-1");
            expect((await third.workspaces.get(database.context, "workspace-1"))?.status).toBe(
                "archived",
            );
            third.durableFunctions.stop();
            await third.workspaces.close(database.context);
            await second.workspaces.close(database.context);
            await first.workspaces.close(database.context);
        } finally {
            database.close();
        }
    });
});

async function expectArchived(
    world: ReturnType<typeof workspacesCatalogFrom>,
    ctx: Parameters<typeof world.workspaces.get>[0],
    workspaceId: string,
): Promise<void> {
    await vi.waitFor(async () => {
        expect((await world.workspaces.get(ctx, workspaceId))?.status).toBe("archived");
    });
}
