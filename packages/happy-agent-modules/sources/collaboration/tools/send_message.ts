import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationSendInputSchema,
    type CollaborationSendInput,
} from "../CollaborationAgent.js";

/** Send one message along a direct collaboration relationship. */
export function sendMessageTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "send_agent_message",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["message subagent", "reply to parent agent", "steer collaborator"],
        description: [
            "Send a message to a collaborator you created, or back to the agent that created you.",
            "",
            "Messages are one-way. A reply to your creator steers its active turn so it can continue with the message; a message to your collaborator joins its queue. This returns as soon as the message is delivered, and there is nothing to wait on.",
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
