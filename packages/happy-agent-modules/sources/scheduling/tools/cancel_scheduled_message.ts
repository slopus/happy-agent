import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingCancelInputSchema,
    schedulingScheduledMessageSchema,
    type SchedulingCancelInput,
} from "../Scheduling.js";

export function cancelScheduledMessageTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_scheduled_message",
        defer: true,
        capabilities: ["Wait and schedule durable messages for future delivery."],
        searchKeywords: ["cancel reminder", "withdraw future message", "stop scheduled delivery"],
        description:
            "Withdraw a message you scheduled, by ID. A message already delivered stays delivered.",
        parameters: schedulingCancelInputSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingCancelInput) =>
            await scheduling.cancelSchedule(ctx, agentId, input),
        toLLM: (schedule) => [
            { type: "text", text: scheduling.formatCancellationForModel(schedule) },
        ],
    });
}
