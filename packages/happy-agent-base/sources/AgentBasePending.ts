import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { AgentPersistence } from "./AgentPersistence.js";
import { cuid2Schema } from "./AgentMetadata.js";

/**
 * The one key an agent's outstanding work lives under, in the agent's own store. It is a single
 * key rather than a prefix of many, because what it records is one fact — that this agent has
 * something left to do — and two keys could disagree about it.
 */
export const AGENT_BASE_PENDING_KEY = "owed";

/**
 * Where a run stopped, and so what has to happen to carry it on. The stage is what a restart
 * reads instead of guessing the answer from the shape of the conversation: a transcript ending
 * in a user message may be a question nobody answered or a response that had nothing to say,
 * and only the run that stopped knows which.
 */
export const AgentBasePendingStage = Type.Union([
    /** An inference request is owed: a message was consumed, or tool results completed. */
    Type.Literal("inference"),
    /** A dispatched tool batch has not delivered all of its results. */
    Type.Literal("tools"),
    /** The conversation is being replaced by the provider's summary of it. */
    Type.Literal("compaction"),
    /** The loop has ended and its durable settlement transaction remains to commit. */
    Type.Literal("settlement"),
]);
export type AgentBasePendingStage = Static<typeof AgentBasePendingStage>;

/**
 * The agent's outstanding work, as the run itself recorded it. Its presence is the whole of the
 * active flag: a stored record means the agent has work left, and the absence of one means it
 * settled. The run erases it on the way out, so an agent that stopped without erasing it — a
 * process that died mid-turn — is discovered as owing exactly what it was doing.
 */
export const AgentBasePendingState = Type.Object({
    stage: AgentBasePendingStage,
    loopId: cuid2Schema,
    turnId: Type.Optional(cuid2Schema),
    inferenceId: Type.Optional(cuid2Schema),
    settlementId: Type.Optional(cuid2Schema),
});
export type AgentBasePendingState = Static<typeof AgentBasePendingState>;

/**
 * Read one store's pending state, or undefined when it holds none. Anything stored under the key
 * that is not a pending state is treated as no pending state at all: a store this agent cannot
 * make sense of must not be able to strand an identity in a stage that will never be carried out.
 */
export async function agentBasePendingStateOf(
    ctx: Context,
    persistence: AgentPersistence,
): Promise<AgentBasePendingState | undefined> {
    const entries = await persistence.readValues(ctx, AGENT_BASE_PENDING_KEY);
    const stored = entries.find((entry) => entry.key === AGENT_BASE_PENDING_KEY)?.value;
    if (stored === undefined) return undefined;
    if (!Value.Check(AgentBasePendingState, stored)) return undefined;
    return stored;
}

/**
 * Whether one agent's store has work left, asked from outside the agent. This is the question an
 * owner starting up needs answered — which identities are worth resuming — and the one it needs
 * again before declaring an identity finished.
 *
 * Only the pending record counts. Conversation shape is deliberately not a liveness signal: a
 * completed response may legitimately leave any role at the tail, while scheduling work records
 * its pending state atomically with the durable change that made the work due.
 */
export async function agentBaseStoreOwesWork(
    ctx: Context,
    persistence: AgentPersistence,
): Promise<boolean> {
    return (await agentBasePendingStateOf(ctx, persistence)) !== undefined;
}
