import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Adds the indexed Rig receipt used to retry and restore Agent Base submissions. */
export async function agentMessageSubmissions(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE INDEX IF NOT EXISTS agent_values_key_agent
            ON agent_values (key, agent_id)
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS agent_message_submissions (
                agent_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                delivery TEXT NOT NULL CHECK (delivery IN ('run', 'steer')),
                status TEXT NOT NULL CHECK (status IN ('queued', 'consumed', 'settled')),
                fingerprint TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                message_json TEXT NOT NULL,
                input_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (agent_id, message_id)
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE INDEX IF NOT EXISTS agent_message_submissions_agent_status
            ON agent_message_submissions (agent_id, status, created_at_ms, message_id)
        `),
    );
    await database.run(
        sql.raw(`
            CREATE INDEX IF NOT EXISTS agent_message_submissions_agent_run_status
            ON agent_message_submissions (agent_id, run_id, status, message_id)
        `),
    );
}
