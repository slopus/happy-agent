import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Adds Rig's archive for the Agent Base History feature. */
export async function agentHistory(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS agent_history (
                agent_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                record_id TEXT NOT NULL,
                message_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, position),
                UNIQUE (agent_id, record_id)
            )
        `),
    );
}
