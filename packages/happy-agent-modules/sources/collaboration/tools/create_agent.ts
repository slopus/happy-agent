import {
    defineAgentTool,
    type AgentModel,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationCreateInputSchema,
    collaborationCreateResultSchema,
    type CollaborationCreateInput,
    type CollaborationCreator,
} from "../CollaborationAgent.js";

/**
 * Create a collaborator and hand it its opening task. `creatorPermissionMode` is the creating
 * agent's persistent mode, which the collaborator runs in unless the call sets read_only or full_mode.
 */
export function createAgentTool(
    collaboration: CollaborationModule,
    thisAgentId: string,
    creator: CollaborationCreator,
    creatorPermissionMode: AgentPermissionMode,
    options: string,
    maxCollaborators: number,
    maxCollaborationDepth: number,
) {
    return defineAgentTool({
        name: "create_agent",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["spawn subagent", "delegate work", "parallel collaborator"],
        description: createAgentDescription(options, maxCollaborators, maxCollaborationDepth),
        parameters: collaborationCreateInputSchema,
        returnType: collaborationCreateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: CollaborationCreateInput, call) =>
            await collaboration.createToolAgent(
                ctx,
                thisAgentId,
                withCurrentProvider(input, creator.provider, collaboration.availableModels()),
                call.id,
                creator,
                creatorPermissionMode,
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
        "Create a hidden collaborator for internal work, such as research. Create collaborators only when the user or project instructions ask for delegation or parallel agents. Bots, tasks, and subtasks use create_subtask only for substantial, distinct workstreams (e.g. changes across projects) or explicit subtask requests, within eligibility and depth limits. Handle small steps inline. Usually create second-level subtasks only on explicit user request.",
        "",
        "The collaborator works on its own. This call returns as soon as the task is delivered, and the collaborator's final message arrives later as its report — nothing here waits for it. Its intermediate messages never reach you; it may still message you on purpose.",
        `Use send_agent_message with a collaborator's ID to continue it with its context intact; a new create_agent call starts a fresh collaborator with no memory of earlier work, so the task must be self-contained. Archive a collaborator with archive_agent once its work is done. At most ${maxCollaborators} collaborators that are not archived, counting the ones they create, may sit under the nearest subtask or top-level agent at or above you; each subtask has its own limit. The maximum depth is ${maxCollaborationDepth} agents including that subtask or top-level agent.`,
        "Choose an exact model and effort; harness and provider default to yours when they serve the model. Switch them later only when needed, with model fields on send_agent_message.",
        "When serviceTier is omitted, the collaborator inherits your tier if the chosen model and provider support it; otherwise it uses regular service.",
        "The collaborator runs in your current permission mode. Set read_only to run it in Read only. Set full_mode to run it in Full access, which is allowed only while you are in Full access yourself.",
        "",
        options,
        "",
        "Call agent_options for the current list.",
    ].join("\n");
}
