import { AgentKV, agentKV, withAgentKV } from "@slopus/happy-agent-base";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import { assertGoalPersistence, validatedGoalPersistence, type GoalStorage } from "./goalStore.js";

const goalToolKVNamespace = createContextNamespace<AgentKV | undefined>(
    "goalToolCallKV",
    undefined,
);

/** The feature-owned per-agent scope used by public operations and hooks. */
export function goalKV(storage: GoalStorage, agentId: string): AgentKV {
    const persistence = storage.persistence.call(storage, agentId);
    assertGoalPersistence(persistence);
    return new AgentKV(validatedGoalPersistence(persistence), `kv.${agentId}.`).scoped(
        "feature",
        "goal",
    );
}

/**
 * Scope a tool execution exactly as Agent Base scopes this feature's tool hooks. The private
 * namespace distinguishes a real durable call from an ordinary host context that happens to
 * carry an agent KV.
 */
export function withGoalToolContext(ctx: Context): Context {
    const callKV = agentKV(ctx);
    if (callKV === undefined) {
        throw new Error("Goal tools require an Agent Base call-scoped store.");
    }
    const scoped = callKV.scoped("feature", "goal");
    return goalToolKVNamespace.set(withAgentKV(ctx, scoped), scoped);
}

/** The Goal-owned store for this durable tool call, when the context came from a Goal tool. */
export function goalToolKV(ctx: Context): AgentKV | undefined {
    return goalToolKVNamespace.get(ctx);
}
