import type { Context } from "@steve.kite/stdlib";

import { and, eq, gte, sql } from "drizzle-orm";

import { sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";

export async function sessionRewind(
    ctx: Context,
    sessionId: string,
    position: number,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_rewind", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .delete(sessionMessages)
            .where(
                and(
                    eq(sessionMessages.sessionId, sessionId),
                    gte(sessionMessages.position, position),
                ),
            )
            .run();
        await tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
        await tx.run(sql`
            INSERT INTO session_turns (session_id, run_id, first_position)
            SELECT session_id, run_id, MIN(position)
            FROM session_messages
            WHERE session_id = ${sessionId} AND run_id IS NOT NULL AND is_partial = 0
            GROUP BY session_id, run_id
        `);
    });
}
