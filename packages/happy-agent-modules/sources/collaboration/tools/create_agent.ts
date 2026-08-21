import { defineAgentTool, type AgentModel } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationCreateInputSchema,
    collaborationCreateResultSchema,
    type CollaborationCreateInput,
} from "../CollaborationAgent.js";

/** Create a collaborator and hand it its opening task. */
export function createAgentTool(
    collaboration: CollaborationModule,
    thisAgentId: string,
    currentProviderId: string,
    models: readonly AgentModel[],
) {
    return defineAgentTool({
        name: "create_agent",
        description: createAgentDescription(models),
        parameters: collaborationCreateInputSchema,
        returnType: collaborationCreateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationCreateInput, call) =>
            await collaboration.createAgent(
                ctx,
                thisAgentId,
                withCurrentProvider(input, currentProviderId, models),
                call.id,
            ),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Created collaborator ${agentId} and sent it the task. Anything it has to say will arrive as a message; nothing is waiting on it.`,
            },
        ],
    });
}

/** Omitted provider means the creator's route when that route serves the requested model. */
function withCurrentProvider(
    input: CollaborationCreateInput,
    currentProviderId: string,
    models: readonly AgentModel[],
): CollaborationCreateInput {
    if (input.provider !== undefined) return input;
    const currentProviderServesModel = models.some(
        (model) => model.id === input.model && model.providerId === currentProviderId,
    );
    return currentProviderServesModel ? { ...input, provider: currentProviderId } : input;
}

/**
 * The description is built once from the collection's models, so a model sees the same tool on
 * every turn and provider prompt caching still applies.
 */
function createAgentDescription(models: readonly AgentModel[]): string {
    const available = models.map(
        (model) =>
            `- ${model.providerId} + ${model.id} (${model.name}; effort: ${model.effortLevels.join(", ")}${
                model.serviceTiers === undefined ? "" : `; tiers: ${model.serviceTiers.join(", ")}`
            })`,
    );
    return [
        "Create a collaborator and give it its first task. Use only when collaboration is explicitly requested.",
        "",
        "The collaborator works on its own. This call returns as soon as the task is delivered, and anything the collaborator has to say arrives later as a message — nothing here waits for it.",
        "Choose an exact model and effort. Omitting provider uses your current provider when it serves that model; otherwise provider is optional only when the model ID is unambiguous. This is the only chance to choose: a collaborator's model, effort, and permissions cannot be changed afterwards.",
        ...(available.length === 0 ? [] : ["Available model/provider pairs:", ...available]),
    ].join("\n");
}
