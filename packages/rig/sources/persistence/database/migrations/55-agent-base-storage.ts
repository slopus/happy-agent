import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Adds Agent Base's append-only conversation records and feature key-value storage. */
export async function agentBaseStorage(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS agent_records (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                record_json TEXT NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE INDEX IF NOT EXISTS agent_records_agent_sequence
            ON agent_records (agent_id, sequence)
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS agent_values (
                agent_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, key)
            )
        `),
    );
}
