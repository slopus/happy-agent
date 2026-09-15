import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import {
    agentSpawnPresentationSchema,
    type AgentSpawnPresentation,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    historyAgentIdSchema,
    historyRecordIdSchema,
    historyMessageSchema,
    historyMessageWithinPersistenceBounds,
    type HistoryMessage,
} from "../HistoryMessage.js";

/** Read the original call through its durable index, never through the current model catalog. */
export async function queryToolSpawnMessage(
    ctx: Context,
    agentId: string,
    callId: string,
): Promise<HistoryMessage | undefined> {
    if (
        !Value.Check(historyAgentIdSchema, agentId) ||
        !Value.Check(historyRecordIdSchema, callId)
    ) {
        throw new Error("The history module received an invalid spawn lookup.");
    }
    const rows = await agentDatabaseRows<{ message_json: string }>(
        ctx.db,
        sql`SELECT message_json FROM happy_agent_module_history
            WHERE agent_id = ${agentId} AND record_id = (
                SELECT record_id FROM happy_agent_module_history_tool_calls
                WHERE agent_id = ${agentId} AND call_id = ${callId} LIMIT 1
            ) LIMIT 1`,
    );
    if (rows[0] === undefined) return undefined;
    const message: unknown = JSON.parse(rows[0].message_json);
    if (!Value.Check(historyMessageSchema, message)) {
        throw new Error("The stored spawn message is invalid.");
    }
    return message;
}

/** Atomically add a resolved identity or successful child ID without rewriting recorded facts. */
export async function queryRecordToolSpawnPresentation(
    ctx: Context,
    agentId: string,
    callId: string,
    presentation: AgentSpawnPresentation,
): Promise<HistoryMessage | undefined> {
    if (!Value.Check(agentSpawnPresentationSchema, presentation)) {
        throw new Error("The history module received an invalid spawn presentation.");
    }
    return await ctx.inTx(async (txCtx) => {
        const message = await queryToolSpawnMessage(txCtx, agentId, callId);
        if (message === undefined)
            throw new Error("The spawning tool call is missing from history.");
        const call = message.blocks.find(
            (block) => block.type === "tool_call" && block.callId === callId,
        );
        if (call?.type !== "tool_call" || call.name !== "create_agent") {
            throw new Error("The spawn presentation does not belong to a creation call.");
        }
        const previous = call.spawnPresentation;
        if (
            previous?.model !== undefined &&
            presentation.model !== undefined &&
            (previous.model.modelId !== presentation.model.modelId ||
                previous.model.providerId !== presentation.model.providerId ||
                previous.model.name !== presentation.model.name)
        ) {
            throw new Error("The spawning tool call already has another resolved model.");
        }
        if (
            previous?.agentId !== undefined &&
            presentation.agentId !== undefined &&
            previous.agentId !== presentation.agentId
        ) {
            throw new Error("The spawning tool call already has another child identity.");
        }
        const model = previous?.model ?? presentation.model;
        const childId = previous?.agentId ?? presentation.agentId;
        const resolved: AgentSpawnPresentation = {
            type: "agent_spawn",
            ...(model === undefined ? {} : { model }),
            ...(childId === undefined ? {} : { agentId: childId }),
        };
        if (JSON.stringify(previous) === JSON.stringify(resolved)) return undefined;
        const updated: HistoryMessage = {
            ...message,
            blocks: message.blocks.map((block) =>
                block === call ? { ...call, spawnPresentation: resolved } : block,
            ),
        };
        if (!historyMessageWithinPersistenceBounds(updated)) {
            throw new Error("The spawn presentation exceeds its durable message bounds.");
        }
        await agentDatabaseRun(
            txCtx.db,
            sql`UPDATE happy_agent_module_history
            SET message_json = ${JSON.stringify(updated)}
            WHERE agent_id = ${agentId} AND record_id = ${message.recordId}`,
        );
        return updated;
    });
}
