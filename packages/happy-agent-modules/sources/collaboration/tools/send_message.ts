import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationSendToolInputSchema,
    type CollaborationCreator,
    type CollaborationModelChoice,
    type CollaborationSendToolInput,
} from "../CollaborationAgent.js";

/**
 * Send one message to an Agent ID allowed by the installation's collaboration boundary.
 * `creator` is the sending agent, whose provider and harness resolve a model switch exactly as
 * they resolve `create_agent`.
 */
export function sendMessageTool(
    collaboration: CollaborationModule,
    actingAgentId: string,
    crossWorkspace: boolean,
    creator: CollaborationCreator,
) {
    return defineAgentTool({
        name: "send_agent_message",
        defer: true,
        capabilities: [
            "Create, message, and coordinate coding subagents.",
            ...(crossWorkspace ? ["Message agents by Agent ID across workspaces."] : []),
        ],
        searchKeywords: [
            "message subagent",
            "reply to parent agent",
            "steer collaborator",
            "switch subagent model",
            ...(crossWorkspace ? ["message agent by id", "cross workspace agent"] : []),
        ],
        description: [
            crossWorkspace
                ? "Send a message to any existing agent by its Agent ID, including an agent in another workspace. Agent IDs are unguessable and must be shared with you."
                : "Send a message to a collaborator you created, or back to the agent that created you.",
            "",
            "Messages are one-way and steer the recipient's active turn in either direction. This returns as soon as the message is delivered, and there is nothing to wait on.",
            "",
            "To switch a collaborator or subtask you created directly to another model, add model and effort, plus harness, provider, or serviceTier when needed; they take the same choices as create_agent, listed by agent_options, and harness and provider default to yours when they serve the model. The recipient changes model when it reads this message, after its current step if it is working. A model that cannot read its earlier conversation starts fresh with a handoff notice. Keep an agent on one model unless its model is failing or wrong for the work. Any other recipient is refused.",
        ].join("\n"),
        parameters: collaborationSendToolInputSchema,
        returnType: Type.Void(),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationSendToolInput, call) => {
            const { toAgentId, explanation, text } = input;
            await collaboration.sendMessage(
                ctx,
                actingAgentId,
                { toAgentId, explanation, text },
                call.id,
                switchOf(input),
                creator,
            );
        },
        toLLM: () => [
            {
                type: "text",
                text: "Message delivered. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ],
    });
}

/** The model the message switches its recipient to, or undefined when it names none. */
function switchOf(input: CollaborationSendToolInput): CollaborationModelChoice | undefined {
    const { model, effort, harness, provider, serviceTier } = input;
    if (
        model === undefined &&
        effort === undefined &&
        harness === undefined &&
        provider === undefined &&
        serviceTier === undefined
    ) {
        return undefined;
    }
    if (model === undefined || effort === undefined) {
        throw new Error(
            "To switch the recipient's model, give both model and effort; harness, provider, and serviceTier are optional.",
        );
    }
    return {
        model,
        effort,
        ...(harness === undefined ? {} : { harness }),
        ...(provider === undefined ? {} : { provider }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
    };
}
