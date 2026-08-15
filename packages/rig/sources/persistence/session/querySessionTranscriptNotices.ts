import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { SESSION_TRANSCRIPT_NOTICE_LIMIT } from "../../protocol/index.js";
import type { PersistedSessionMessage } from "../../session/InMemorySession.js";
import { readNumber, readString } from "./impl/sqliteRow.js";

export interface SessionTranscriptNoticeSlice {
    messages: readonly PersistedSessionMessage[];
    truncated: boolean;
}

/** Reads a separately bounded slice of runless service rows without consuming turn capacity. */
export async function querySessionTranscriptNotices(
    ctx: Context,
    sessionId: string,
    lowerPosition: number,
    upperPosition: number,
): Promise<SessionTranscriptNoticeSlice> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_session_transcript_notices",
        async (ctx) => {
            const tx = ctx.tx;
            const rows = (
                await tx.all<Record<string, unknown>>(sql`
            SELECT position, run_id, message_json
            FROM session_messages
            WHERE session_id = ${sessionId}
              AND run_id IS NULL
              AND role = 'system'
              AND is_partial = 0
              AND json_extract(message_json, '$.context') = 'excluded'
              AND position >= ${lowerPosition}
              AND position < ${upperPosition}
            ORDER BY position DESC
            LIMIT ${SESSION_TRANSCRIPT_NOTICE_LIMIT + 1}
        `)
            ).reverse();
            const truncated = rows.length > SESSION_TRANSCRIPT_NOTICE_LIMIT;
            return {
                messages: rows.slice(truncated ? 1 : 0).map((row) => ({
                    message: JSON.parse(readString(row, "message_json")) as Message,
                    position: readNumber(row, "position"),
                })),
                truncated,
            };
        },
    );
}
