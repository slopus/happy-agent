import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";

const directories: string[] = [];

/** The schema version this feature's migration produces. */
const SCOPE_SHARING_SCHEMA_VERSION = 24;

const SCOPE_SHARING_TABLES = [
    "scope_share_entries",
    "scope_share_grants",
    "scope_share_members",
    "scope_share_outbox",
    "scope_share_replica_entries",
    "scope_share_replicas",
    "scope_share_session_cursors",
    "scope_shares",
];

/**
 * Schema later migrations add, which the rewind above has to take with it.
 *
 * A real database at the scope-sharing version has none of this, so replaying
 * forward from that version has to start from a database that has none of it
 * either — otherwise a later `CREATE TABLE` meets its own output. Every
 * migration that lands after this one adds its tables here.
 */
const TABLES_ADDED_AFTER_SCOPE_SHARING = [
    "p2p_peer_pairings",
    "p2p_peers",
    "session_share_capabilities",
    "session_share_peer_actions",
];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("scope sharing migration", () => {
    it("adds the scope sharing tables to a database at the previous version", () => {
        const opened = openTestDatabase();
        try {
            migrateSessionDatabase(opened.database);
            // Rewind to the schema this feature was written against and replay
            // forward. Everything a later migration added has to go with it, or
            // the replay meets its own output; the rewind is pinned to this
            // feature's own schema version rather than to whatever happens to be
            // last, because migrations keep landing behind it.
            for (const table of SCOPE_SHARING_TABLES) {
                opened.database.run(sql.raw(`DROP TABLE "${table}"`));
            }
            for (const table of TABLES_ADDED_AFTER_SCOPE_SHARING) {
                opened.database.run(sql.raw(`DROP TABLE "${table}"`));
            }
            opened.database.run(sql.raw("ALTER TABLE session_shares DROP COLUMN tool_output"));
            opened.database.run(
                sql.raw(`PRAGMA user_version = ${String(SCOPE_SHARING_SCHEMA_VERSION - 1)}`),
            );

            migrateSessionDatabase(opened.database);

            expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
                user_version: CURRENT_SESSION_DATABASE_VERSION,
            });
            expect(
                opened.database
                    .all<{ name: string }>(
                        sql.raw(
                            `SELECT name FROM sqlite_master
                             WHERE type = 'table' AND name LIKE 'scope_share%' ORDER BY name`,
                        ),
                    )
                    .map((row) => row.name),
            ).toEqual(SCOPE_SHARING_TABLES);
        } finally {
            opened.client.close();
        }
    });

    it("indexes at most one live share per scope and lets a stopped one be replaced", () => {
        const opened = openTestDatabase();
        try {
            migrateSessionDatabase(opened.database);
            opened.database.run(
                sql.raw(`INSERT INTO projects (
                    id, path, storage_key, kind, name, name_key, name_source, order_key,
                    initialization_status, initialization_attempt, presence, worktree_support,
                    git_ahead, git_behind, git_detached, version, created_at_ms, updated_at_ms
                ) VALUES (
                    'project-1', '/p', 'p', 'regular', 'p', 'p', 'folder', 'a0',
                    'ready', 0, 'present', 'supported', 0, 0, 0, 1, 1, 1
                )`),
            );

            insertShare(opened.database, "share-1", "active");

            expect(() => insertShare(opened.database, "share-2", "active")).toThrow();
            // The index is partial, so a degraded share still holds the scope and a
            // stopped one lets go of it.
            expect(() => insertShare(opened.database, "share-3", "degraded")).toThrow();
            opened.database.run(
                sql.raw("UPDATE scope_shares SET state = 'stopped' WHERE share_id = 'share-1'"),
            );
            insertShare(opened.database, "share-4", "active");

            expect(
                opened.database.get<{ count: number }>(
                    sql.raw("SELECT COUNT(*) AS count FROM scope_shares"),
                ),
            ).toEqual({ count: 2 });
        } finally {
            opened.client.close();
        }
    });
});

function insertShare(
    database: ReturnType<typeof openSessionDatabase>["database"],
    shareId: string,
    state: string,
): void {
    database.run(
        sql.raw(`INSERT INTO scope_shares (
            share_id, scope_kind, scope_id, project_id, state, owner_peer_id,
            created_at_ms, updated_at_ms
        ) VALUES (
            '${shareId}', 'workspace', 'workspace-1', 'project-1', '${state}', 'peer-owner', 1, 1
        )`),
    );
}

function openTestDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "scope-sharing-migration-"));
    directories.push(directory);
    return openSessionDatabase(join(directory, "sessions.db"));
}
