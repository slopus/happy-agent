import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationFeature } from "../CollaborationFeature.js";
import {
    collaborationSendToolInputSchema,
    collaborationSendResultSchema,
    type CollaborationSendToolInput,
} from "../CollaborationMessage.js";

/** Queue one durable message and, optionally, a durable reply obligation. */
export function sendMessageTool(collaboration: CollaborationFeature, actingAgentId: string) {
    return defineAgentTool({
        name: "send_agent_message",
        description:
            "Send a text message to another collaborator. Set expectReply when the recipient must answer; then use wait_for_reply.",
        parameters: collaborationSendToolInputSchema,
        returnType: collaborationSendResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationSendToolInput) =>
            await collaboration.sendMessage(ctx, actingAgentId, input),
        toLLM: ({ message, obligation }) => [
            {
                type: "text",
                text: `Message ${message.id} sent to ${message.toAgentId}.${
                    obligation === undefined ? "" : ` Reply obligation: ${obligation.id}.`
                }`,
            },
        ],
    });
}
