import { describe, expect, it } from "vitest";

import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations, type WorkspaceEvent } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

describe("archival cleanup interrupted by a shutdown resumes at the next startup", () => {
    it("carries a workspace stranded in archiving through to archived when it opens", async () => {
        const config = await temporaryTestConfig();
        const database = moduleDatabase([], "stranded-archival-recovery");
        await database.ready;
        for (const [, migrate] of projectMigrations) {
            await migrate(database.context, database.database);
        }
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
        try {
            // The first run archives a workspace and shuts down while folder removal is still in
            // flight. Archival commits the decision and defers removal past the commit, so the
            // close lands between the two: the durable record says `archiving`, and the completion
            // that would have moved it to `archived` never ran. This is an ordinary graceful
            // shutdown racing an archive, not a crash.
            const first = workspacesCatalogFrom(config);
            first.start(database.context);
            const project = await first.projects.create(database.context, {
                name: "Acme",
                repositoryRef: "/projects/acme",
            });
            await first.workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: project.id,
                name: "Interrupted workspace",
            });
            await first.workspaces.archive(database.context, "workspace-1");
            await first.workspaces.close(database.context);
            const stranded = await first.workspaces.get(database.context, "workspace-1");
            expect(stranded?.status).toBe("archiving");

            // A second catalog over the same records is the daemon starting again. Opening it must
            // finish what the shutdown interrupted: the row reaches `archived`, and the
            // `workspace_archived` event the first run still owed its subscribers is published.
            const second = workspacesCatalogFrom(config);
            second.start(database.context);
            const events: WorkspaceEvent[] = [];
            second.workspaces.onEvent((_ctx, event) => {
                events.push(event);
            });
            await second.workspaces.open(database.context);
            await second.workspaces.whenCleanupSettles();

            const recovered = await second.workspaces.get(database.context, "workspace-1");
            expect(recovered?.status).toBe("archived");
            expect(
                events.some(
                    (event) =>
                        event.type === "workspace_archived" && event.workspace.id === "workspace-1",
                ),
            ).toBe(true);

            // Startup recovery is a repair, not a new decision: it reaches into no agents, and a
            // third run finds nothing left to do.
            expect(second.agents.aborted).toEqual([]);
            await second.workspaces.close(database.context);
            const third = workspacesCatalogFrom(config);
            third.start(database.context);
            await third.workspaces.open(database.context);
            await third.workspaces.whenCleanupSettles();
            expect((await third.workspaces.get(database.context, "workspace-1"))?.status).toBe(
                "archived",
            );
            await third.workspaces.close(database.context);
        } finally {
            database.close();
        }
    });
});
