import { defineAgentTool, type AgentModel } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationCreateInputSchema,
    collaborationCreateResultSchema,
    type CollaborationCreateInput,
    type CollaborationCreator,
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
        parameters: collaborationCreateInputSchema,
        returnType: collaborationCreateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationCreateInput, call) =>
            await collaboration.createToolAgent(
                ctx,
                thisAgentId,
                withCurrentProvider(input, creator.provider, collaboration.availableModels()),
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
        "Choose an exact model and effort; harness and provider default to yours when they serve the model. They cannot be changed afterwards.",
        "",
        options,
        "",
        "Call agent_options for the current list.",
    ].join("\n");
}
