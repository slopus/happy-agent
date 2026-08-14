import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { submissionFingerprintSchema, type SessionEvent } from "../../protocol/index.js";
import { inReadTx } from "../inReadTx.js";
import { readSessionEventRow } from "./impl/sessionEventRow.js";

/**
 * Find the durable submission event for one message identity.
 *
 * SessionEventLog intentionally retains only a bounded in-memory suffix. Agent Base keeps the
 * caller-owned message identity durable for idempotency, so protocol retries need this indexed
 * lookup when the presentation event has already fallen out of that suffix.
 */
export async function querySessionMessageSubmission(
    ctx: Context,
    sessionId: string,
    messageId: string,
): Promise<Extract<SessionEvent, { type: "message_submitted" }> | undefined> {
    return await inReadTx(ctx, "rig.sql.session.query_message_submission", async (ctx) => {
        const row = await ctx.tx
            .all<Record<string, unknown>>(sql`
                SELECT event_id, type, created_at_ms, data_json
                FROM session_events
                WHERE session_id = ${sessionId}
                  AND type = 'message_submitted'
                  AND message_id = ${messageId}
                ORDER BY seq ASC
                LIMIT 1
            `)
            .then((rows) => rows[0]);
        if (row === undefined) return undefined;
        const event = readSessionEventRow(row, sessionId);
        if (
            event.type !== "message_submitted" ||
            event.data.message.id !== messageId ||
            (event.data.submissionFingerprint !== undefined &&
                !Value.Check(submissionFingerprintSchema, event.data.submissionFingerprint))
        ) {
            throw new Error("The session submission index contains an invalid event.");
        }
        return event;
    });
}
