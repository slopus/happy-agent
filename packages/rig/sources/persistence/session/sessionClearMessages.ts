import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import { sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";

export async function sessionClearMessages(ctx: Context, sessionId: string): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_clear_messages", async (ctx) => {
        const tx = ctx.tx;
        await tx.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).run();
        await tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
    });
}
