import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { artifactMigrations } from "../../sources/artifacts/ArtifactMigrations.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const WITHDRAW = "007-withdraw-sidebar-artifacts";

describe("artifact withdrawn types migration", () => {
    it("deletes sidebar artifacts with their versions, files, and unused inline text", async () => {
        const earlier = artifactMigrations.filter(([key]) => key !== WITHDRAW);
        const migration = artifactMigrations.find(([key]) => key === WITHDRAW);
        if (migration === undefined) throw new Error("Expected the withdrawal migration.");
        const database = moduleDatabase([...earlier], "artifact-withdrawn-types-migration");
        await database.ready;
        try {
            const run = (query: ReturnType<typeof sql>) =>
                agentDatabaseRun(database.database, query);
            for (const [id, type, digest] of [
                ["sidebarone", "sidebar", "sidebardigest"],
                ["proposalone", "sidebar_proposal", "proposaldigest"],
                ["notesone", "markdown", "notesdigest"],
            ] as const) {
                await run(sql`INSERT INTO happy_agent_module_artifacts
                    (id, type, title, status, latest_version, entry_json, file_count, size,
                     created_by_json, created_by_kind, created_at, updated_by_json, updated_at,
                     revision)
                    VALUES (${id}, ${type}, 'Title', 'active', 1, '{}', 1, 1, '{}', 'user', 0,
                            '{}', 0, 1)`);
                await run(sql`INSERT INTO happy_agent_module_artifact_versions
                    (artifact_id, number, title, entry_path, created_by_json, created_at)
                    VALUES (${id}, 1, 'Title', 'index.html', '{}', 0)`);
                await run(sql`INSERT INTO happy_agent_module_artifact_files
                    (artifact_id, version_number, path, mime_type, size, sha256)
                    VALUES (${id}, 1, 'index.html', 'text/html', 1, ${digest})`);
                await run(sql`INSERT INTO happy_agent_module_artifact_inline (sha256, content)
                    VALUES (${digest}, 'x')`);
            }
            // A staged upload still needs its inline text after the migration.
            await run(sql`INSERT INTO happy_agent_module_artifact_uploads
                (id, size, sha256, utf8, created_at, expires_at)
                VALUES ('pendingupload', 1, 'pendingdigest', 1, 0, 1)`);
            await run(sql`INSERT INTO happy_agent_module_artifact_inline (sha256, content)
                VALUES ('pendingdigest', 'x')`);

            await migration[1](database.context, database.database);

            const ids = async (table: string, column: string) =>
                (
                    await agentDatabaseRows<{ value: string }>(
                        database.database,
                        sql`SELECT ${sql.raw(column)} AS value FROM ${sql.raw(table)} ORDER BY 1`,
                    )
                ).map((row) => row.value);
            expect(await ids("happy_agent_module_artifacts", "id")).toEqual(["notesone"]);
            expect(await ids("happy_agent_module_artifact_versions", "artifact_id")).toEqual([
                "notesone",
            ]);
            expect(await ids("happy_agent_module_artifact_files", "artifact_id")).toEqual([
                "notesone",
            ]);
            expect(await ids("happy_agent_module_artifact_inline", "sha256")).toEqual([
                "notesdigest",
                "pendingdigest",
            ]);
        } finally {
            database.close();
        }
    });
});
