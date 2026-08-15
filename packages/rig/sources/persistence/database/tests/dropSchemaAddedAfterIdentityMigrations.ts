import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../SessionDatabase.js";
import { agentSessionSharing } from "../migrations/18-agent-session-sharing.js";
import { sessionShareEntryLog } from "../migrations/19-session-share-entry-log.js";

/**
 * Removes the schema that migrations after the data-identity ones create.
 *
 * A test that rewinds `user_version` to replay an identity migration replays
 * every later migration with it, so that later schema has to go too; a real
 * database at that schema version never has it. Without this, a replayed
 * `CREATE TABLE` or `ADD COLUMN` meets its own output and the rewind fails.
 */
export async function dropSchemaAddedAfterIdentityMigrations(
    database: SessionDatabase,
): Promise<void> {
    await database.run(sql.raw("DROP TRIGGER IF EXISTS folders_shared_subtree_contents_update"));
    await dropFolderItemsAndDocumentsSchema(database);
    await dropSessionScopeSchema(database);
    await database.run(sql.raw("DROP TABLE IF EXISTS sharing_settings"));
    await database.run(sql.raw("DROP TABLE IF EXISTS sharing_profile_binding"));
    for (const table of await database.all<{ name: string }>(
        sql.raw(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND (
                   name LIKE 'happy_cloud_%'
                   OR name LIKE 'scope_share%'
                   OR name LIKE 'worklet%'
                   OR name IN ('folder_catalog', 'folder_mutations', 'folders', 'p2p_peer_pairings', 'p2p_peers', 'rig_profiles', 'session_mutations')
               )`,
        ),
    )) {
        await database.run(sql.raw(`DROP TABLE "${table.name}"`));
    }
    await database.run(sql.raw("DROP INDEX IF EXISTS sessions_unsorted"));
    await database.run(sql.raw("ALTER TABLE sessions DROP COLUMN unsorted_since_ms"));
    await database.run(sql.raw("DROP INDEX IF EXISTS sessions_folder"));
    await database.run(sql.raw("ALTER TABLE sessions DROP COLUMN folder_id"));
    await database.run(sql.raw("ALTER TABLE project_workspaces ADD COLUMN title TEXT"));
    await database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN name_configured"));
    await database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN branch"));
    await agentSessionSharing(database);
    await sessionShareEntryLog(database);
}

export async function dropFolderItemsAndDocumentsSchema(database: SessionDatabase): Promise<void> {
    for (const table of [
        "folder_item_mutations",
        "folder_items",
        "document_mutations",
        "document_updates",
        "documents",
    ]) {
        await database.run(sql.raw(`DROP TABLE IF EXISTS "${table}"`));
    }
}

/** Rebuilds migration 36's checked table into the migration 35 shape before older rewinds. */
export async function dropSessionScopeSchema(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("DROP TRIGGER IF EXISTS folders_shared_subtree_contents_update"));
    const stored = await database.get<{ sql: string }>(
        sql.raw("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (stored === undefined || !stored.sql.includes("scope_kind")) return;
    const checkStart = stored.sql.lastIndexOf(",\n            CHECK (");
    if (checkStart === -1) throw new Error("The scoped session check was not found.");
    const definition = `${stored.sql
        .slice(0, checkStart)
        .replace(/^CREATE TABLE\s+"?sessions"?/u, "CREATE TABLE sessions_before_scope")
        .replace(/\n\s*scope_kind TEXT NOT NULL DEFAULT 'project',/u, "")
        .replace(
            "project_id TEXT REFERENCES projects(id)",
            "project_id TEXT NOT NULL REFERENCES projects(id)",
        )}\n        )`;
    const columns = (await database.all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)")))
        .map((column) => column.name)
        .filter((name) => name !== "scope_kind");
    const selected = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    await database.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        await database.run(sql.raw(definition));
        await database.run(
            sql.raw(
                `INSERT INTO sessions_before_scope (${selected}) SELECT ${selected} FROM sessions`,
            ),
        );
        await database.run(sql.raw("DROP TABLE sessions"));
        await database.run(sql.raw("ALTER TABLE sessions_before_scope RENAME TO sessions"));
    } finally {
        await database.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
    const legacyColumns = await database.all<{ name: string }>(
        sql.raw("PRAGMA table_info(sessions)"),
    );
    if (!legacyColumns.some((column) => column.name === "external_tools_json")) {
        await database.run(
            sql.raw(
                "ALTER TABLE sessions ADD COLUMN external_tools_json TEXT NOT NULL DEFAULT '[]'",
            ),
        );
    }
    if (!legacyColumns.some((column) => column.name === "durable_skills_json")) {
        await database.run(
            sql.raw(
                "ALTER TABLE sessions ADD COLUMN durable_skills_json TEXT NOT NULL DEFAULT '[]'",
            ),
        );
    }
}
