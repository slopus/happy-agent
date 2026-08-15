import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

/**
 * The Unsorted chats that have run out of time, oldest first.
 *
 * Unsorted is where a chat is born, recorded as the moment it began belonging nowhere, and not
 * merely the absence of a folder: a chat that belongs to a project or a workspace has no folder
 * either and is sorted by belonging there, so it must never be swept. An Unsorted chat can file
 * itself while the user talks to it, and one that still has no folder a day later is put away. Only
 * chats of the user's own belong there: a subagent belongs to the session that started it and a
 * delegated chat to the agent that opened it, so neither is ever a candidate. The batch is bounded
 * so one sweep cannot load the whole history.
 */
export async function queryExpiredUnsortedSessions(
    ctx: Context,
    unsortedBefore: number,
    limit: number,
): Promise<readonly string[]> {
    return await inDatabase(ctx, "rig.sql.session.query_expired_unsorted_sessions", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.all<Record<string, unknown>>(
                sql`
                SELECT id FROM sessions
                WHERE unsorted_since_ms IS NOT NULL
                    AND scope_kind = 'unsorted'
                    AND unsorted_since_ms <= ${unsortedBefore}
                    AND folder_id IS NULL
                    AND archived = 0
                    AND session_kind = 'primary'
                    AND parent_session_id IS NULL
                    AND delegated_by_session_id IS NULL
                ORDER BY unsorted_since_ms ASC, id ASC
                LIMIT ${limit}
            `,
            )
        ).map((row) => readString(row, "id"));
    });
}
