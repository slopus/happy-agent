import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Removes the retired integration-owned external tool call persistence. */
export async function removeExternalToolCalls(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("DROP INDEX IF EXISTS external_tool_calls_session_created"));
    await database.run(sql.raw("DROP TABLE IF EXISTS external_tool_calls"));
    const sessionColumns = await database.all<{ name: string }>(
        sql.raw("PRAGMA table_info(sessions)"),
    );
    if (sessionColumns.some((column) => column.name === "external_tools_json")) {
        await database.run(sql.raw("ALTER TABLE sessions DROP COLUMN external_tools_json"));
    }
    if (sessionColumns.some((column) => column.name === "durable_skills_json")) {
        await database.run(sql.raw("ALTER TABLE sessions DROP COLUMN durable_skills_json"));
    }
}
