import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationFeature } from "../CollaborationFeature.js";
import {
    collaborationObligationSchema,
    collaborationWaitToolInputSchema,
    type CollaborationWaitToolInput,
} from "../CollaborationMessage.js";

/** Wait on a host-owned durable reply obligation. */
export function waitForReplyTool(collaboration: CollaborationFeature, agentId: string) {
    return defineAgentTool({
        name: "wait_for_reply",
        description:
            "Wait until a collaborator answers one of this agent's pending reply obligations. The host owns the durable wait and may suspend this tool across restarts.",
        parameters: collaborationWaitToolInputSchema,
        returnType: collaborationObligationSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationWaitToolInput) =>
            await collaboration.waitForReply(ctx, agentId, input),
        toLLM: (obligation) => [
            {
                type: "text",
                text: `Reply obligation ${obligation.id} is ${obligation.status}${
                    obligation.status !== "answered"
                        ? ""
                        : ` (answer ${obligation.answerMessageId}).`
                }`,
            },
        ],
    });
}
