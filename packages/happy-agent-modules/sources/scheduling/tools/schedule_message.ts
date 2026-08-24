import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingScheduleToolInputSchema,
    schedulingScheduledMessageSchema,
} from "../Scheduling.js";

/**
 * Providers require an object at the root of a tool's parameters, so the absolute time and duration
 * variants stay a closed union and travel as one argument.
 */
const scheduleMessageToolParametersSchema = Type.Object(
    { input: schedulingScheduleToolInputSchema },
    { additionalProperties: false },
);

type ScheduleMessageToolParameters = Static<typeof scheduleMessageToolParametersSchema>;

export function scheduleMessageTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "schedule_message",
        defer: true,
        capabilities: ["Wait and schedule durable messages for future delivery."],
        searchKeywords: ["schedule future message", "durable reminder", "delayed agent message"],
        description:
            "Send a message at a future time to any agent whose ID you know, including yourself. Give the time as a duration in `in`, or as a date in `at` written as ISO 8601, RFC 2822, or a Unix timestamp. The message is kept and delivered even if this session restarts first.",
        parameters: scheduleMessageToolParametersSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: ScheduleMessageToolParameters, call) => {
            const { agent_id: targetAgentId, ...scheduleInput } = input;
            return await scheduling.schedule(ctx, agentId, {
                ...scheduleInput,
                id: call.id,
                targetAgentId,
            });
        },
        toLLM: (schedule) => [{ type: "text", text: scheduling.formatScheduleForModel(schedule) }],
    });
}
