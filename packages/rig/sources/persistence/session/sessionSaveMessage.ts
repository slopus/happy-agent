import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import { sessionMessages, sessionTurns } from "../database/schema.js";
import type { PersistedSessionMessage } from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";

export async function sessionSaveMessage(
    ctx: Context,
    sessionId: string,
    message: PersistedSessionMessage,
    updatedAt: number,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_save_message", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(sessionMessages)
            .values({
                isPartial: false,
                messageId: message.message.id,
                messageJson: JSON.stringify(message.message),
                position: message.position,
                role: message.message.role,
                runId: message.runId ?? null,
                sessionId,
                updatedAtMs: updatedAt,
            })
            .onConflictDoUpdate({
                set: {
                    isPartial: sql`excluded.is_partial`,
                    messageId: sql`excluded.message_id`,
                    messageJson: sql`excluded.message_json`,
                    role: sql`excluded.role`,
                    runId: sql`excluded.run_id`,
                    updatedAtMs: sql`excluded.updated_at_ms`,
                },
                target: [sessionMessages.sessionId, sessionMessages.position],
            })
            .run();
        if (message.runId === undefined) return;
        await tx
            .insert(sessionTurns)
            .values({
                firstPosition: message.position,
                runId: message.runId,
                sessionId,
            })
            .onConflictDoUpdate({
                set: {
                    firstPosition: sql`MIN(${sessionTurns.firstPosition}, excluded.first_position)`,
                },
                target: [sessionTurns.sessionId, sessionTurns.runId],
            })
            .run();
    });
}
