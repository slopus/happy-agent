import {
    historyAgentIdSchema,
    historyMessageWithinPersistenceBounds,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TOTAL_MESSAGES,
    type HistoryMessage,
} from "@slopus/happy-agent-features";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, eq, lt, sql } from "drizzle-orm";

import { agentHistory } from "../database/schema.js";
import { inTx } from "../inTx.js";

const positiveIntegerSchema = Type.Integer({
    maximum: MAX_HISTORY_TOTAL_MESSAGES,
    minimum: 1,
});

/** Append feature history in the caller's existing SessionDatabase transaction. */
export async function agentHistoryAppend(
    ctx: Context,
    agentId: string,
    messages: readonly HistoryMessage[],
    maxRecords = 10_000,
): Promise<void> {
    if (
        !Value.Check(historyAgentIdSchema, agentId) ||
        !Value.Check(positiveIntegerSchema, maxRecords) ||
        messages.length > MAX_HISTORY_MESSAGES_PER_APPEND
    ) {
        throw new Error("Rig history retention must be a positive integer.");
    }
    for (const message of messages) {
        if (!historyMessageWithinPersistenceBounds(message)) {
            throw new Error("The history feature produced an invalid message.");
        }
    }
    if (messages.length === 0) return;

    await inTx(ctx, "rig.sql.agent_history.append", async (ctx) => {
        const pending: HistoryMessage[] = [];
        const seen = new Map<string, string>();
        for (const message of messages) {
            const messageJson = JSON.stringify(message);
            if (messageJson === undefined || !historyMessageWithinPersistenceBounds(message)) {
                throw new Error("The history feature produced an invalid message.");
            }
            const recordId = message.recordId;
            const prior = seen.get(recordId);
            if (prior !== undefined) {
                if (prior !== messageJson) {
                    throw new Error("A history record ID cannot be reused for different content.");
                }
                continue;
            }
            seen.set(recordId, messageJson);
            const existing = await ctx.tx
                .select({ messageJson: agentHistory.messageJson })
                .from(agentHistory)
                .where(and(eq(agentHistory.agentId, agentId), eq(agentHistory.recordId, recordId)))
                .get();
            if (existing !== undefined) {
                if (existing.messageJson !== messageJson) {
                    throw new Error("A history record ID cannot be reused for different content.");
                }
                continue;
            }
            pending.push(message);
        }
        if (pending.length === 0) return;
        const last = await ctx.tx.get<{ position: number }>(sql`
            SELECT COALESCE(MAX(position), -1) AS position
            FROM agent_history
            WHERE agent_id = ${agentId}
        `);
        const firstPosition = last?.position === undefined ? 0 : last.position + 1;
        if (
            !Number.isSafeInteger(firstPosition) ||
            firstPosition < 0 ||
            firstPosition > MAX_HISTORY_POSITION - pending.length + 1
        ) {
            throw new Error("Rig history position limit reached.");
        }
        await ctx.tx
            .insert(agentHistory)
            .values(
                pending.map((message, index) => ({
                    agentId,
                    recordId: message.recordId,
                    messageJson: JSON.stringify(message),
                    position: firstPosition + index,
                })),
            )
            .run();
        const minimumPosition = firstPosition + pending.length - maxRecords;
        if (minimumPosition > 0) {
            await ctx.tx
                .delete(agentHistory)
                .where(
                    and(
                        eq(agentHistory.agentId, agentId),
                        lt(agentHistory.position, minimumPosition),
                    ),
                )
                .run();
        }
    });
}
