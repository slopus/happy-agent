import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const legacyAgentRuntimeTables = [
    "queued_runs",
    "pending_context_messages",
    "durable_user_inputs",
    "durable_waits",
] as const;

/**
 * Removes persistence owned by Rig's retired agent runtime.
 *
 * Agent Base and its features own pending agent work and durable tool state. Rig retains only its
 * product, protocol-projection, and Agent Base storage tables.
 */
export async function removeLegacyAgentRuntime(database: SessionDatabase): Promise<void> {
    for (const table of legacyAgentRuntimeTables) {
        await database.run(sql.raw(`DROP TABLE IF EXISTS ${table}`));
    }
    const sessionColumns = await database.all<{ name: string }>(
        sql.raw("PRAGMA table_info(sessions)"),
    );
    if (sessionColumns.some((column) => column.name === "workspace_queue_waiting")) {
        await database.run(sql.raw("ALTER TABLE sessions DROP COLUMN workspace_queue_waiting"));
    }
}