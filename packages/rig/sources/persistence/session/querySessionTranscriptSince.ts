import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { EventId } from "../../protocol/index.js";
import { inReadTx } from "../inReadTx.js";
import { readNumber, readOptionalString, readString } from "./impl/sqliteRow.js";
import {
    querySessionTranscriptNotices,
    type SessionTranscriptNoticeSlice,
} from "./querySessionTranscriptNotices.js";

export type SessionTranscriptMessageRange = SessionTranscriptNoticeSlice;

export async function querySessionTranscriptSince(
    ctx: Context,
    sessionId: string,
    turnLimit: number,
    after: EventId,
): Promise<SessionTranscriptMessageRange | undefined> {
    return await inReadTx(ctx, "rig.sql.session.query_session_transcript_since", async (ctx) => {
        const tx = ctx.tx;
        const anchor = await tx.get<Record<string, unknown>>(sql`
        SELECT
            messages.position,
            messages.run_id,
            COALESCE(turns.first_position, messages.position) AS first_position
        FROM session_events AS events
        JOIN session_messages AS messages
          ON messages.session_id = events.session_id
         AND messages.message_id = events.message_id
         AND messages.is_partial = 0
        LEFT JOIN session_turns AS turns
          ON turns.session_id = messages.session_id
         AND turns.run_id = messages.run_id
        WHERE events.session_id = ${sessionId} AND events.event_id = ${after}
        LIMIT 1
    `);
        if (anchor === undefined) return undefined;
        const anchorPosition = readNumber(anchor, "position");
        const anchorRunId = readOptionalString(anchor, "run_id");
        const lowerPosition =
            anchorRunId === undefined ? anchorPosition : readNumber(anchor, "first_position");
        const runRows = await tx.all<Record<string, unknown>>(sql`
        SELECT turns.run_id, turns.first_position FROM session_turns AS turns
        WHERE turns.session_id = ${sessionId}
          AND turns.first_position >= ${lowerPosition}
        ORDER BY turns.first_position ASC
        LIMIT ${turnLimit}
    `);
        const runIds = runRows.map((row) => readString(row, "run_id"));
        const turnMessages =
            runIds.length === 0
                ? []
                : (
                      await tx.all<Record<string, unknown>>(sql`
                      SELECT position, run_id, message_json
                      FROM session_messages
                      WHERE session_id = ${sessionId}
                          AND is_partial = 0
                          AND run_id IN (${sql.join(
                              runIds.map((id) => sql`${id}`),
                              sql`, `,
                          )})
                      ORDER BY position ASC
                  `)
                  ).map((row) => ({
                      message: JSON.parse(readString(row, "message_json")) as Message,
                      position: readNumber(row, "position"),
                      runId: readString(row, "run_id"),
                  }));
        const lastRunPosition = runRows.at(-1);
        const nextRun =
            lastRunPosition === undefined
                ? undefined
                : await tx.get<Record<string, unknown>>(sql`
                  SELECT first_position
                  FROM session_turns
                  WHERE session_id = ${sessionId}
                    AND first_position > ${readNumber(lastRunPosition, "first_position")}
                  ORDER BY first_position ASC
                  LIMIT 1
              `);
        const upperPosition =
            nextRun === undefined ? Number.MAX_SAFE_INTEGER : readNumber(nextRun, "first_position");
        const notices = await querySessionTranscriptNotices(
            ctx,
            sessionId,
            lowerPosition,
            upperPosition,
        );
        if (turnMessages.length === 0 && notices.messages.length === 0) return undefined;
        return {
            messages: [...turnMessages, ...notices.messages].sort(
                (left, right) => left.position - right.position,
            ),
            truncated: notices.truncated,
        };
    });
}
