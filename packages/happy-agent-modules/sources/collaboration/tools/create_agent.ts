import {
    agentEffort,
    agentModel,
    agentServiceTier,
    defineAgentTool,
    type AgentModel,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationCreateResultSchema,
    collaborationServiceTierSchema,
    collaborationToolCreateInputSchema,
    type CollaborationCreateInput,
    type CollaborationCreator,
    type CollaborationToolCreateInput,
} from "../CollaborationAgent.js";

/** Create a collaborator and hand it its opening task. */
export function createAgentTool(
    collaboration: CollaborationModule,
    thisAgentId: string,
    creator: CollaborationCreator,
    options: string,
    maxCollaborators: number,
    maxCollaborationDepth: number,
) {
    return defineAgentTool({
        name: "create_agent",
        // Eager, like Claude Code's Agent and Codex's spawn_agent: delegation is ordinary work, and
        // a subagent the model has to search for first is one it rarely thinks to start.
        defer: false,
        capabilities: ["Create, message, and coordinate coding subagents."],
        description: createAgentDescription(options, maxCollaborators, maxCollaborationDepth),
        parameters: collaborationToolCreateInputSchema,
        returnType: collaborationCreateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationToolCreateInput, call) =>
            await collaboration.createToolAgent(
                ctx,
                thisAgentId,
                withCreatorDefaults(ctx, input, creator, collaboration.availableModels()),
                call.id,
                creator,
            ),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Created collaborator ${agentId} and sent it the task. Anything it has to say will arrive as a message; nothing is waiting on it.`,
            },
        ],
    });
}

/**
 * Fill in what the call left to its creator, as Codex's `spawn_agent` does: an omitted model is the
 * creator's own, an omitted effort is the creator's when the model offers it and the model's
 * default otherwise, and an omitted provider is the creator's route when that route serves the
 * model. The creator's service tier carries over only with its own model.
 */
function withCreatorDefaults(
    ctx: Context,
    input: CollaborationToolCreateInput,
    creator: CollaborationCreator,
    models: readonly AgentModel[],
): CollaborationCreateInput {
    const modelId = input.model ?? agentModel(ctx) ?? creator.model;
    if (modelId === undefined) {
        throw new Error("Choose a model for the collaborator: your own model is not known here.");
    }
    const provider =
        input.provider ??
        (models.some((model) => model.id === modelId && model.providerId === creator.provider)
            ? creator.provider
            : undefined);
    const candidate = models.find(
        (model) =>
            model.id === modelId && (provider === undefined || model.providerId === provider),
    );
    if (candidate === undefined) {
        throw new Error(
            provider === undefined
                ? `Model "${modelId}" is not available for collaborators.`
                : `Model "${modelId}" is not available from provider "${provider}".`,
        );
    }
    const creatorEffort = agentEffort(ctx);
    const effort =
        input.effort ??
        (creatorEffort !== undefined && candidate.effortLevels.includes(creatorEffort)
            ? creatorEffort
            : candidate.defaultEffort);
    const creatorTier = input.model === undefined ? agentServiceTier(ctx) : undefined;
    const serviceTier =
        input.serviceTier ??
        (Value.Check(collaborationServiceTierSchema, creatorTier) &&
        candidate.serviceTiers?.includes(creatorTier) === true
            ? creatorTier
            : undefined);
    return {
        title: input.title,
        model: modelId,
        effort,
        ...(input.harness === undefined ? {} : { harness: input.harness }),
        ...(provider === undefined ? {} : { provider }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
        text: input.text,
    };
}

/**
 * `options` is the listing frozen when the agent's tools were first built, so the description
 * never changes; later changes arrive as notices, and agent_options lists the current ones.
 */
function createAgentDescription(
    options: string,
    maxCollaborators: number,
    maxCollaborationDepth: number,
): string {
    return [
        "Create a hidden collaborator for internal work, such as research. Bots, tasks, and subtasks use create_subtask only for substantial, distinct workstreams (e.g. changes across projects) or explicit subtask requests, within eligibility and depth limits. Handle small steps inline. Usually create second-level subtasks only on explicit user request.",
        "",
        "The collaborator works on its own. This call returns as soon as the task is delivered, and anything the collaborator has to say arrives later as a message — nothing here waits for it.",
        `One root agent tree may contain at most ${maxCollaborators} ordinary collaborators. Reuse one with send_agent_message after reaching the limit, or archive one that can no longer work (for example, its provider fails) with archive_agent to free its place. The maximum depth is ${maxCollaborationDepth} agents including the root. Subtasks belong to the tree but count toward neither limit; collaborators they create do count.`,
        "Omit model and effort to run the collaborator on your own model and effort; set them only when the user asks for a different model or the task clearly calls for one. Harness and provider default to yours when they serve the model. The collaborator works under your permission mode. None of this can be changed afterwards.",
        "",
        options,
        "",
        "Call agent_options for the current list.",
    ].join("\n");
}
