import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { PersistedSessionMessage } from "../../session/InMemorySession.js";
import { inReadTx } from "../inReadTx.js";
import { readNumber, readString } from "./impl/sqliteRow.js";
import { querySessionTranscriptNotices } from "./querySessionTranscriptNotices.js";

export interface SessionTranscriptMessagePage {
    messages: readonly PersistedSessionMessage[];
    noticesTruncated: boolean;
}

export async function querySessionTranscriptPage(
    ctx: Context,
    sessionId: string,
    turnLimit: number,
    before?: string,
): Promise<SessionTranscriptMessagePage | undefined> {
    return await inReadTx(ctx, "rig.sql.session.query_session_transcript_page", async (ctx) => {
        const tx = ctx.tx;
        const beforeRow =
            before === undefined
                ? undefined
                : await tx.get<Record<string, unknown>>(sql`
                  SELECT first_position
                  FROM session_turns
                  WHERE session_id = ${sessionId} AND run_id = ${before}
              `);
        // Partial-only runs have messages but no session_turns row. They are not
        // valid transcript page anchors and must not be dereferenced as one.
        if (before !== undefined && beforeRow === undefined) return undefined;
        const beforePosition =
            beforeRow === undefined
                ? Number.MAX_SAFE_INTEGER
                : readNumber(beforeRow, "first_position");
        const runRows = await tx.all<Record<string, unknown>>(sql`
        SELECT run_id, first_position FROM session_turns
        WHERE session_id = ${sessionId}
          AND first_position < ${beforePosition}
        ORDER BY first_position DESC
        LIMIT ${turnLimit}
    `);
        const orderedRows = runRows.reverse();
        const runIds = orderedRows.map((row) => readString(row, "run_id"));
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
        const firstPosition =
            orderedRows.length === 0 ? undefined : readNumber(orderedRows[0]!, "first_position");
        const hasEarlierTurn =
            firstPosition !== undefined &&
            (await tx.get(sql`
            SELECT 1 FROM session_turns
            WHERE session_id = ${sessionId}
              AND first_position < ${firstPosition}
            LIMIT 1
        `)) !== undefined;
        // The oldest turn owns every preceding runless notice. Using the turn's
        // first message as this bound would permanently hide notices recorded while idle.
        const lowerPosition = firstPosition === undefined || !hasEarlierTurn ? 0 : firstPosition;
        const notices = await querySessionTranscriptNotices(
            ctx,
            sessionId,
            lowerPosition,
            beforePosition,
        );
        return {
            messages: [...turnMessages, ...notices.messages].sort(
                (left, right) => left.position - right.position,
            ),
            noticesTruncated: notices.truncated,
        };
    });
}
