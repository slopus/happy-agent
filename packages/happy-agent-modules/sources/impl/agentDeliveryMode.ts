import {
    agentEffort,
    agentModel,
    agentProvider,
    agentServiceTier,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentBaseMessageOptions,
    type AgentModel,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { messageModeSchema, type MessageMode } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

/**
 * The mode one agent's message gives a conversation that has never been given one.
 *
 * Agent Base holds no model for a new agent: the first message names it, and a person's message
 * always does. When an agent speaks first instead — a task's opening text, or the first word to a
 * bot nobody has talked to yet — the conversation runs on the sender's own selection while this
 * installation still offers it, and otherwise on the installation's default model. A conversation
 * that already has a mode keeps it, so a later message never overrides a person's choice. The
 * permission mode is the one Agent Base gives a new agent, sent explicitly so the recorded mode is
 * what the conversation actually runs with.
 *
 * `ctx` is the sender's: its agent context carries the selection the sender is running on.
 */
export async function agentDeliveryMode(
    ctx: Context,
    agents: AgentSystemRef,
    models: readonly AgentModel[],
    toAgentId: string,
): Promise<AgentDeliveryMode | undefined> {
    const config = await agents.config(ctx, toAgentId);
    if (Value.Check(messageModeSchema, config?.metadata?.["lastMode"])) return undefined;
    const providerId = agentProvider(ctx);
    const modelId = agentModel(ctx);
    const inherited = models.find(
        (model) => model.providerId === providerId && model.id === modelId,
    );
    const model = inherited ?? models[0];
    if (model === undefined) return undefined;
    const requestedEffort = inherited === undefined ? undefined : agentEffort(ctx);
    const effort =
        requestedEffort !== undefined && model.effortLevels.includes(requestedEffort)
            ? requestedEffort
            : model.defaultEffort;
    const requestedTier = inherited === undefined ? undefined : agentServiceTier(ctx);
    const serviceTier =
        requestedTier !== undefined && model.serviceTiers?.includes(requestedTier) === true
            ? requestedTier
            : null;
    return {
        mode: {
            providerId: model.providerId,
            modelId: model.id,
            effort,
            serviceTier,
            permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
        },
        options: {
            provider: model.providerId,
            model: model.id,
            effort,
            serviceTier,
            permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
        },
    };
}

/** A conversation's first mode: the one to record, and the send options that run with it. */
export interface AgentDeliveryMode {
    readonly mode: MessageMode;
    readonly options: Pick<
        AgentBaseMessageOptions,
        "effort" | "model" | "permissionMode" | "provider" | "serviceTier"
    >;
}
