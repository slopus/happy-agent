import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Removes the schema that migrations after the data-identity ones create.
 *
 * A test that rewinds `user_version` to replay an identity migration replays
 * every later migration with it, so that later schema has to go too; a real
 * database at that schema version never has it. Without this, a replayed
 * `CREATE TABLE` or `ADD COLUMN` meets its own output and the rewind fails.
 */
export function dropSchemaAddedAfterIdentityMigrations(database: SessionDatabase): void {
    for (const table of database.all<{ name: string }>(
        sql.raw(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND (
                   name LIKE 'happy_cloud_%'
                   OR name LIKE 'scope_share%'
                   OR name IN ('p2p_peer_pairings', 'p2p_peers', 'session_share_capabilities', 'session_share_peer_actions')
               )`,
        ),
    )) {
        database.run(sql.raw(`DROP TABLE "${table.name}"`));
    }
    if (
        database
            .all<{ name: string }>(sql.raw("PRAGMA table_info(session_shares)"))
            .some((column) => column.name === "tool_output")
    ) {
        database.run(sql.raw("ALTER TABLE session_shares DROP COLUMN tool_output"));
    }
}
