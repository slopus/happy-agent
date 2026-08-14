import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationFeature } from "../CollaborationFeature.js";
import {
    collaborationReplyToolInputSchema,
    collaborationSendResultSchema,
    type CollaborationReplyToolInput,
} from "../CollaborationMessage.js";

/** Answer one directed reply obligation through the same durable host operation boundary. */
export function replyToMessageTool(collaboration: CollaborationFeature, actingAgentId: string) {
    return defineAgentTool({
        name: "reply_to_agent_message",
        description:
            "Reply to a collaborator's pending request. Only the requested responder may answer an obligation.",
        parameters: collaborationReplyToolInputSchema,
        returnType: collaborationSendResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationReplyToolInput) =>
            await collaboration.replyMessage(ctx, actingAgentId, input),
        toLLM: ({ message }) => [
            {
                type: "text",
                text: `Reply ${message.id} sent to ${message.toAgentId}.`,
            },
        ],
    });
}
