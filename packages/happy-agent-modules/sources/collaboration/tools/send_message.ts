import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationSendInputSchema,
    type CollaborationSendInput,
} from "../CollaborationAgent.js";

/** Send one message to an Agent ID allowed by the installation's collaboration boundary. */
export function sendMessageTool(
    collaboration: CollaborationModule,
    actingAgentId: string,
    crossWorkspace: boolean,
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
            ...(crossWorkspace ? ["message agent by id", "cross workspace agent"] : []),
        ],
        description: [
            crossWorkspace
                ? "Send a message to any existing agent by its Agent ID, including an agent in another workspace. Agent IDs are unguessable and must be shared with you."
                : "Send a message to a collaborator you created, or back to the agent that created you.",
            "",
            "Messages are one-way and steer the recipient's active turn in either direction. This returns as soon as the message is delivered, and there is nothing to wait on.",
        ].join("\n"),
        parameters: collaborationSendInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationSendInput, call) => {
            await collaboration.sendMessage(ctx, actingAgentId, input, call.id);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Message delivered. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ],
    });
}
