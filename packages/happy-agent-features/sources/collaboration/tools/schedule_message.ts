import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationFeature } from "../CollaborationFeature.js";
import {
    collaborationScheduleToolInputSchema,
    collaborationScheduleSchema,
    type CollaborationScheduleToolInput,
} from "../CollaborationMessage.js";

/** Schedule a durable host-owned delivery without creating a feature-owned timer or queue. */
export function scheduleMessageTool(collaboration: CollaborationFeature, actingAgentId: string) {
    return defineAgentTool({
        name: "schedule_message",
        description:
            "Schedule a message for a collaborator at a host-owned due time. The host keeps delivery durable across restarts.",
        parameters: collaborationScheduleToolInputSchema,
        returnType: collaborationScheduleSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationScheduleToolInput) =>
            await collaboration.scheduleMessage(ctx, actingAgentId, input),
        toLLM: (scheduled) => [
            {
                type: "text",
                text: `Scheduled message ${scheduled.id} for ${scheduled.targetAgentId} at ${new Date(
                    scheduled.dueAt,
                ).toISOString()}.`,
            },
        ],
    });
}
