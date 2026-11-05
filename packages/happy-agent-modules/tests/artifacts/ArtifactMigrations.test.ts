import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    ARTIFACT_VERSIONS_TABLE,
    artifactMigrations,
    ARTIFACTS_TABLE,
} from "../../sources/artifacts/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("the artifact migrations", () => {
    it("labels versions made before labels existed 1.0, 1.1, and so on", async () => {
        const labels = artifactMigrations.findIndex(
            ([name]) => name === "004-artifact-version-labels",
        );
        expect(labels).toBeGreaterThan(0);
        const database = moduleDatabase(artifactMigrations.slice(0, labels), "artifact-migrations");
        await database.ready;
        const author = JSON.stringify({ kind: "user" });
        await agentDatabaseRun(
            database.database,
            sql`INSERT INTO ${sql.raw(ARTIFACTS_TABLE)} (id, type, title, status, latest_version,
                entry_json, file_count, size, created_by_json, created_by_kind, created_at,
                updated_by_json, updated_at, revision)
                VALUES ('artifactold', 'markdown', 'Old', 'active', 3, '{}', 1, 1, ${author},
                'user', 1, ${author}, 1, 3)`,
        );
        for (const number of [1, 2, 3]) {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO ${sql.raw(ARTIFACT_VERSIONS_TABLE)} (artifact_id, number, title,
                    entry_path, created_by_json, created_at)
                    VALUES ('artifactold', ${number}, 'Old', 'index.md', ${author}, 1)`,
            );
        }

        for (const [, migrate] of artifactMigrations.slice(labels)) {
            await migrate(database.context, database.database);
        }

        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT latest_version, latest_major, latest_minor FROM ${sql.raw(ARTIFACTS_TABLE)}`,
            ),
        ).toEqual([{ latest_version: 3, latest_major: 1, latest_minor: 2 }]);
        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT number, major, minor FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
                    ORDER BY number`,
            ),
        ).toEqual([
            { number: 1, major: 1, minor: 0 },
            { number: 2, major: 1, minor: 1 },
            { number: 3, major: 1, minor: 2 },
        ]);
        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT live_json FROM ${sql.raw(ARTIFACTS_TABLE)}`,
            ),
        ).toEqual([{ live_json: null }]);
        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT live_json FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)} ORDER BY number`,
            ),
        ).toEqual([{ live_json: null }, { live_json: null }, { live_json: null }]);
        database.close();
    });

    it("marks earlier images' versions for a default cover, and nothing else", async () => {
        const covers = artifactMigrations.findIndex(
            ([name]) => name === "008-artifact-cover-summary",
        );
        expect(covers).toBeGreaterThan(0);
        const database = moduleDatabase(artifactMigrations.slice(0, covers), "artifact-covers");
        await database.ready;
        const author = JSON.stringify({ kind: "user" });
        for (const [id, type] of [
            ["artifactpicture", "image"],
            ["artifactframes", "image_series"],
            ["artifactnotes", "markdown"],
        ] as const) {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO ${sql.raw(ARTIFACTS_TABLE)} (id, type, title, status,
                    latest_version, entry_json, file_count, size, created_by_json,
                    created_by_kind, created_at, updated_by_json, updated_at, revision)
                    VALUES (${id}, ${type}, 'Old', 'active', 1, '{}', 1, 1, ${author}, 'user', 1,
                    ${author}, 1, 1)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO ${sql.raw(ARTIFACT_VERSIONS_TABLE)} (artifact_id, number, title,
                    entry_path, created_by_json, created_at)
                    VALUES (${id}, 1, 'Old', 'a', ${author}, 1)`,
            );
        }

        for (const [, migrate] of artifactMigrations.slice(covers)) {
            await migrate(database.context, database.database);
        }

        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT artifact_id, cover_json, cover_default, summary
                    FROM ${sql.raw(ARTIFACT_VERSIONS_TABLE)} ORDER BY artifact_id`,
            ),
        ).toEqual([
            { artifact_id: "artifactframes", cover_json: null, cover_default: 1, summary: null },
            { artifact_id: "artifactnotes", cover_json: null, cover_default: null, summary: null },
            { artifact_id: "artifactpicture", cover_json: null, cover_default: 1, summary: null },
        ]);
        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT cover_json, summary FROM ${sql.raw(ARTIFACTS_TABLE)} LIMIT 1`,
            ),
        ).toEqual([{ cover_json: null, summary: null }]);
        database.close();
    });
});
