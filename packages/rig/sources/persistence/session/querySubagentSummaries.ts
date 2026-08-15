import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import type { SessionTokenCount, SubagentSummary } from "../../protocol/index.js";
import { parsePersistedUsage } from "./impl/persistedUsage.js";
import { readNumber, readOptionalString, readString } from "./impl/sqliteRow.js";

export async function querySubagentSummaries(
    ctx: Context,
    parentSessionId: string,
): Promise<readonly SubagentSummary[]> {
    return await inDatabase(ctx, "rig.sql.session.query_subagent_summaries", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.all<Record<string, unknown>>(sql`
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM sessions WHERE parent_session_id = ${parentSessionId}
                UNION ALL
                SELECT sessions.id
                FROM sessions
                JOIN descendants ON sessions.parent_session_id = descendants.id
            )
            SELECT id, agent_id, model_id, status, total_tokens,
                session_token_count_json, usage_json, parent_session_id, parent_tool_call_id,
                task_name, depth, description, created_at_ms, updated_at_ms
            FROM sessions
            WHERE id IN descendants
            ORDER BY created_at_ms ASC
        `)
        ).map((row) => {
            const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
            const taskName = readOptionalString(row, "task_name");
            const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
            const persistedUsage = parsePersistedUsage(readOptionalString(row, "usage_json"));
            return {
                agentId: readString(row, "agent_id"),
                createdAt: readNumber(row, "created_at_ms"),
                depth: readNumber(row, "depth"),
                description: readOptionalString(row, "description") ?? "Delegated task",
                id: readString(row, "id"),
                modelId: readString(row, "model_id"),
                parentSessionId: readString(row, "parent_session_id"),
                ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
                status: readString(row, "status") as SubagentSummary["status"],
                ...(taskName !== undefined ? { taskName } : {}),
                totalTokens: readNumber(row, "total_tokens"),
                ...(sessionTokenCountJson === undefined
                    ? {}
                    : {
                          sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount,
                      }),
                updatedAt: readNumber(row, "updated_at_ms"),
                ...(persistedUsage === undefined ? {} : { usage: persistedUsage.committed }),
            };
        });
    });
}
