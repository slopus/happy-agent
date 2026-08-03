import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
    RIG_DATA_IDENTITY_MIGRATION_INDEX,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
} from "../migrateSessionDatabase.js";
import { agentTreeUsage } from "../migrations/08-agent-tree-usage.js";
import { projectComputeGeneration } from "../migrations/12-project-compute-generation.js";
import { projectUserMutationVersion } from "../migrations/16-project-user-mutation-version.js";
import { sessionHostedCapabilities } from "../migrations/29-session-hosted-capabilities.js";
import { openSessionDatabase } from "../openSessionDatabase.js";
import { dropSchemaAddedAfterIdentityMigrations } from "./dropSchemaAddedAfterIdentityMigrations.js";
import * as schema from "../schema.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("migrateSessionDatabase", () => {
    it("creates the complete schema from the init migration", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);

        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });
        expect(
            opened.database
                .all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
                .map((row) => row.name),
        ).toEqual(
            Object.values(schema)
                .map((table) => getTableConfig(table).name)
                .sort(),
        );
        expect(
            opened.database.get<{ workspaceQueueWaiting: number }>(
                sql.raw(
                    "SELECT workspace_queue_waiting AS workspaceQueueWaiting FROM sessions LIMIT 1",
                ),
            ),
        ).toBeUndefined();
        expect(
            opened.database
                .all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
                .map((column) => column.name),
        ).toContain("workspace_queue_waiting");

        opened.client.close();
    });

    it("keeps an initialized database unchanged on later starts", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);
        migrateSessionDatabase(opened.database);

        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });

        opened.client.close();
    });

    it("does not replay the identity migration when the following migration runs", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "stable-epoch" });
        dropSchemaAddedAfterIdentityMigrations(opened.database);
        opened.database.run(sql.raw("ALTER TABLE rig_data_identity DROP COLUMN format_version"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_SCHEMA_VERSION)}`),
        );

        migrateSessionDatabase(opened.database, {
            createDataEpoch: () => {
                throw new Error("The identity migration was replayed.");
            },
        });

        expect(
            opened.database.get(sql.raw("SELECT epoch, format_version FROM rig_data_identity")),
        ).toEqual({ epoch: "stable-epoch", format_version: 1 });
        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });
        opened.client.close();
    });

    it("pins the data identity migration at index 19", () => {
        expect(RIG_DATA_IDENTITY_MIGRATION_INDEX).toBe(19);
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "discarded" });
        dropSchemaAddedAfterIdentityMigrations(opened.database);
        opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_MIGRATION_INDEX)}`),
        );

        migrateSessionDatabase(opened.database, { createDataEpoch: () => "pinned-epoch" });

        expect(
            opened.database.get(sql.raw("SELECT epoch, format_version FROM rig_data_identity")),
        ).toEqual({ epoch: "pinned-epoch", format_version: 1 });
        opened.client.close();
    });

    it("creates and enforces the named identity constraints", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "checked-epoch" });
        const tableSql = opened.database.get<{ sql: string }>(
            sql.raw("SELECT sql FROM sqlite_master WHERE name = 'rig_data_identity'"),
        )?.sql;

        expect(tableSql).toContain("CONSTRAINT rig_data_identity_singleton");
        expect(tableSql).toContain("CONSTRAINT rig_data_identity_format_version");
        expect(() =>
            opened.database.run(sql.raw("UPDATE rig_data_identity SET format_version = 2")),
        ).toThrow();
        expect(() =>
            opened.database.run(
                sql.raw(
                    "INSERT INTO rig_data_identity (singleton, epoch, format_version) VALUES (2, 'other', 1)",
                ),
            ),
        ).toThrow();
        expect(
            opened.database.get(sql.raw("SELECT singleton, format_version FROM rig_data_identity")),
        ).toEqual({ format_version: 1, singleton: 1 });
        opened.client.close();
    });

    it("discards only pre-icon webapps while preserving legacy slot entries", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        opened.database.run(sql.raw("PRAGMA user_version = 9"));
        opened.database.run(sql.raw("CREATE TABLE unrelated_data (value TEXT NOT NULL)"));
        opened.database.run(sql.raw("INSERT INTO unrelated_data (value) VALUES ('keep me')"));
        opened.database.run(
            sql.raw(
                "CREATE TABLE projects (id TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1)",
            ),
        );
        opened.database.run(
            sql.raw(`
                CREATE TABLE slot_entries (
                    id TEXT NOT NULL PRIMARY KEY,
                    slot TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    project_id TEXT,
                    workspace_id TEXT,
                    session_id TEXT,
                    content_json TEXT NOT NULL,
                    author_session_id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                INSERT INTO slot_entries (
                    id,
                    slot,
                    scope,
                    content_json,
                    author_session_id,
                    description,
                    purpose,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    'legacy-slot',
                    'status-line',
                    'everywhere',
                    '{"type":"text","markdown":"Legacy status"}',
                    'session-1',
                    'Legacy status',
                    'Preserve the old slot entry',
                    1,
                    2
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                CREATE TABLE webapps (
                    name TEXT NOT NULL PRIMARY KEY,
                    description TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    author_session_id TEXT NOT NULL,
                    source_description TEXT,
                    current_version INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                CREATE TABLE webapp_versions (
                    webapp_name TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    change_description TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (webapp_name, version)
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                INSERT INTO webapps (
                    name,
                    description,
                    purpose,
                    author_session_id,
                    current_version,
                    created_at_ms,
                    updated_at_ms
                ) VALUES ('old-dashboard', 'Old', 'Old', 'session-1', 1, 1, 1)
            `),
        );
        opened.database.run(
            sql.raw(`
                INSERT INTO webapp_versions (
                    webapp_name,
                    version,
                    change_description,
                    created_at_ms
                ) VALUES ('old-dashboard', 1, 'Initial import', 1)
            `),
        );

        migrateSessionDatabase(opened.database);

        expect(opened.database.all(sql.raw("SELECT * FROM webapps"))).toEqual([]);
        expect(opened.database.all(sql.raw("SELECT * FROM webapp_versions"))).toEqual([]);
        expect(
            opened.database.get(
                sql.raw(`
                    SELECT author_type, author_id, author_name
                    FROM slot_entries
                    WHERE id = 'legacy-slot'
                `),
            ),
        ).toEqual({
            author_type: "agent",
            author_id: "session-1",
            author_name: null,
        });
        expect(opened.database.get(sql.raw("SELECT value FROM unrelated_data"))).toEqual({
            value: "keep me",
        });
        expect(
            opened.database
                .all<{ name: string }>(sql.raw("PRAGMA table_info(webapps)"))
                .map((column) => column.name),
        ).toContain("icon_thumbhash");

        opened.client.close();
    });

    it("atomically replaces a database from the previous migration generation", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("CREATE TABLE legacy_data (value TEXT NOT NULL)"));
        opened.database.run(sql.raw("INSERT INTO legacy_data (value) VALUES ('discard me')"));
        opened.database.run(sql.raw("PRAGMA user_version = 13"));

        migrateSessionDatabase(opened.database);

        expect(
            opened.database.get(
                sql.raw("SELECT name FROM sqlite_master WHERE name = 'legacy_data'"),
            ),
        ).toBeUndefined();
        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });

        opened.client.close();
    });

    it("keeps the init migration atomic", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        opened.database.run(sql.raw("CREATE TABLE project_avatar_assets (hash TEXT PRIMARY KEY)"));

        expect(() => migrateSessionDatabase(opened.database)).toThrow();
        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({ user_version: 0 });
        expect(
            opened.database
                .all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
                .map((row) => row.name),
        ).toEqual(["project_avatar_assets"]);

        opened.client.close();
    });

    it("rejects a database created by an unknown future schema", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION + 1)}`),
        );

        expect(() => migrateSessionDatabase(opened.database)).toThrow(
            new RegExp(`supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}`, "u"),
        );

        opened.client.close();
    });

    it("keeps the Drizzle schema identical to the applied migrations", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);

        for (const table of Object.values(schema)) {
            const config = getTableConfig(table);
            const actualColumns = opened.database.all<{
                name: string;
                notnull: number;
                pk: number;
            }>(sql.raw(`PRAGMA table_info(${config.name})`));
            expect(actualColumns.map((column) => column.name)).toEqual(
                config.columns.map((column) => column.name),
            );
            for (const column of config.columns) {
                const actual = actualColumns.find((candidate) => candidate.name === column.name);
                expect(actual, `${config.name}.${column.name}`).toBeDefined();
                if (column.notNull) {
                    expect(
                        actual!.notnull === 1 ||
                            (actual!.pk > 0 && column.getSQLType() === "integer"),
                        `${config.name}.${column.name} must be NOT NULL`,
                    ).toBe(true);
                }
            }
        }

        opened.client.close();
    });

    it("starts existing project compute settings at generation one", () => {
        const opened = openTestDatabase();
        opened.database.run(
            sql.raw(`
                CREATE TABLE projects (
                    id TEXT NOT NULL PRIMARY KEY,
                    default_compute TEXT,
                    default_docker_image TEXT
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                INSERT INTO projects (id, default_compute, default_docker_image)
                VALUES
                    ('docker', 'docker', 'rig-dev:latest'),
                    ('local', 'local', NULL),
                    ('unset', NULL, NULL)
            `),
        );

        projectComputeGeneration(opened.database);

        expect(
            opened.database.all<{ default_compute_generation: number; id: string }>(
                sql.raw("SELECT id, default_compute_generation FROM projects ORDER BY id"),
            ),
        ).toEqual([
            { default_compute_generation: 1, id: "docker" },
            { default_compute_generation: 1, id: "local" },
            { default_compute_generation: 0, id: "unset" },
        ]);
        opened.client.close();
    });

    it("starts existing project user mutation versions at their current versions", () => {
        const opened = openTestDatabase();
        opened.database.run(
            sql.raw(`
                CREATE TABLE projects (
                    id TEXT NOT NULL PRIMARY KEY,
                    version INTEGER NOT NULL
                )
            `),
        );
        opened.database.run(
            sql.raw(`
                INSERT INTO projects (id, version)
                VALUES ('first', 4), ('second', 9)
            `),
        );

        projectUserMutationVersion(opened.database);

        expect(
            opened.database.all<{
                id: string;
                user_mutation_version: number;
            }>(sql.raw("SELECT id, user_mutation_version FROM projects ORDER BY id")),
        ).toEqual([
            { id: "first", user_mutation_version: 4 },
            { id: "second", user_mutation_version: 9 },
        ]);
        opened.client.close();
    });

    it("adds nullable hosted capabilities without changing existing sessions", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("CREATE TABLE sessions (id TEXT NOT NULL PRIMARY KEY)"));
        opened.database.run(sql.raw("INSERT INTO sessions (id) VALUES ('existing-session')"));

        sessionHostedCapabilities(opened.database);

        expect(
            opened.database.get(
                sql.raw(
                    "SELECT id, hosted_capabilities FROM sessions WHERE id = 'existing-session'",
                ),
            ),
        ).toEqual({
            hosted_capabilities: null,
            id: "existing-session",
        });
        expect(
            opened.database
                .all<{ name: string; notnull: number }>(sql.raw("PRAGMA table_info(sessions)"))
                .find((column) => column.name === "hosted_capabilities"),
        ).toMatchObject({ name: "hosted_capabilities", notnull: 0 });

        opened.client.close();
    });

    it("backfills exact committed lifetime usage and adds the delegated traversal index", () => {
        const opened = openTestDatabase();
        opened.database.run(
            sql.raw(`
            CREATE TABLE sessions (
                id TEXT NOT NULL PRIMARY KEY,
                delegated_by_session_id TEXT,
                created_at_ms INTEGER NOT NULL,
                usage_json TEXT
            )
        `),
        );
        opened.database.run(
            sql.raw(`
            INSERT INTO sessions (id, delegated_by_session_id, created_at_ms, usage_json)
            VALUES
                (
                    'exact',
                    'root',
                    1,
                    '{"committed":{"totalTokens":125},"summary":{"groups":[{"usage":{"totalTokens":100}},{"usage":{"totalTokens":25}}]}}'
                ),
                ('negative', 'root', 2, '{"committed":{"totalTokens":-5}}'),
                ('invalid', 'root', 3, '{invalid'),
                ('missing', NULL, 4, NULL)
        `),
        );

        agentTreeUsage(opened.database);

        expect(
            opened.database.all<{ id: string; lifetime_total_tokens: number }>(
                sql.raw(
                    "SELECT id, lifetime_total_tokens FROM sessions ORDER BY created_at_ms, id",
                ),
            ),
        ).toEqual([
            { id: "exact", lifetime_total_tokens: 125 },
            { id: "negative", lifetime_total_tokens: 0 },
            { id: "invalid", lifetime_total_tokens: 0 },
            { id: "missing", lifetime_total_tokens: 0 },
        ]);
        expect(
            opened.database
                .all<{ detail: string }>(
                    sql.raw(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM sessions INDEXED BY sessions_delegated_created
                        WHERE delegated_by_session_id = 'root'
                        ORDER BY created_at_ms, id
                    `),
                )
                .some((row) => row.detail.includes("sessions_delegated_created")),
        ).toBe(true);

        opened.client.close();
    });
});

function openTestDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "rig-database-init-"));
    directories.push(directory);
    return openSessionDatabase(join(directory, "sessions.sqlite"));
}
