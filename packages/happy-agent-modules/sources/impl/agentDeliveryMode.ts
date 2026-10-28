import {
    agentEffort,
    agentModel,
    agentPermissionMode,
    agentProvider,
    agentServiceTier,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentBaseMessageOptions,
    type AgentModel,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { messageModeSchema, type MessageMode } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { narrowerPermissionMode } from "./delegatedPermissionMode.js";

/**
 * The mode one agent's message gives a conversation that has never been given one.
 *
 * Agent Base holds no model for a new agent: the first message names it, and a person's message
 * always does. When an agent speaks first instead — a task's opening text, or the first word to an
 * idle task seeded with an initial creation mode, or the first word to a bot nobody has talked to yet — the
 * conversation runs on the initial creation choice if one was explicitly chosen, or on the sender's own
 * selection while this installation still offers it, and otherwise on the installation's default model.
 * If an explicitly chosen creation model or its chosen effort/tier is no longer offered by the installation,
 * an actionable error is thrown. A conversation that already has a lastMode keeps it, so a later
 * message never overrides an accepted choice. The permission mode is the one chosen at creation,
 * or else the one Agent Base gives a new agent, never wider than the sender's own: an agent that
 * starts a conversation must not hand it more than it has. It is sent explicitly so the recorded
 * mode is what the conversation actually runs with.
 *
 * `ctx` is the sender's: its agent context carries the selection the sender is running on. The
 * agent-messaging tools that reach here are never lent Full access by an Auto review, so the mode
 * it carries is the sender's own; a context naming no agent carries the product default.
 */
export async function agentDeliveryMode(
    ctx: Context,
    agents: AgentSystemRef,
    models: readonly AgentModel[],
    toAgentId: string,
): Promise<AgentDeliveryMode | undefined> {
    const config = await agents.config(ctx, toAgentId);
    if (Value.Check(messageModeSchema, config?.metadata?.["lastMode"])) {
        return undefined;
    }
    const senderPermissionMode = agentPermissionMode(ctx);
    const initialModeRaw = config?.metadata?.["initialMode"];
    if (Value.Check(messageModeSchema, initialModeRaw)) {
        const initialMode = initialModeRaw as MessageMode;
        const model = models.find(
            (candidate) =>
                candidate.providerId === initialMode.providerId &&
                candidate.id === initialMode.modelId,
        );
        if (model === undefined) {
            throw new Error(
                `The model "${initialMode.modelId}" from provider "${initialMode.providerId}" chosen at task creation is no longer available.`,
            );
        }
        const requestedEffort = initialMode.effort as SessionReasoningEffort;
        if (!model.effortLevels.includes(requestedEffort)) {
            throw new Error(
                `The effort "${requestedEffort}" chosen at task creation is no longer available for model "${model.id}".`,
            );
        }
        const requestedTier = initialMode.serviceTier;
        if (
            requestedTier !== null &&
            requestedTier !== undefined &&
            model.serviceTiers?.includes(requestedTier) !== true
        ) {
            throw new Error(
                `The service tier "${requestedTier}" chosen at task creation is no longer available for model "${model.id}".`,
            );
        }
        const serviceTier = requestedTier ?? null;
        const permissionMode = narrowerPermissionMode(
            initialMode.permissionMode,
            senderPermissionMode,
        );
        return {
            mode: {
                providerId: model.providerId,
                modelId: model.id,
                effort: requestedEffort,
                serviceTier,
                permissionMode,
            },
            options: {
                provider: model.providerId,
                model: model.id,
                effort: requestedEffort,
                serviceTier,
                permissionMode,
            },
        };
    }
    const providerId = agentProvider(ctx);
    const modelId = agentModel(ctx);
    const inherited = models.find(
        (model) => model.providerId === providerId && model.id === modelId,
    );
    const model = inherited ?? models[0];
    if (model === undefined) return undefined;
    const requestedEffort = inherited === undefined ? undefined : agentEffort(ctx);
    const effort: SessionReasoningEffort =
        requestedEffort !== undefined && model.effortLevels.includes(requestedEffort)
            ? requestedEffort
            : model.defaultEffort;
    const requestedTier = inherited === undefined ? undefined : agentServiceTier(ctx);
    const serviceTier =
        requestedTier !== undefined &&
        requestedTier !== null &&
        model.serviceTiers?.includes(requestedTier) === true
            ? requestedTier
            : null;
    const permissionMode = narrowerPermissionMode(
        DEFAULT_AGENT_PERMISSION_MODE,
        senderPermissionMode,
    );
    return {
        mode: {
            providerId: model.providerId,
            modelId: model.id,
            effort,
            serviceTier,
            permissionMode,
        },
        options: {
            provider: model.providerId,
            model: model.id,
            effort,
            serviceTier,
            permissionMode,
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
