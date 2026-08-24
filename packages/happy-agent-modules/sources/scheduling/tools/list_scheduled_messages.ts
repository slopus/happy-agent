import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingSchedulePageSchema,
    schedulingScheduleToolPageQuerySchema,
    type SchedulingScheduleToolPageQuery,
} from "../Scheduling.js";

export function listScheduledMessagesTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "list_scheduled_messages",
        defer: true,
        capabilities: ["Wait and schedule durable messages for future delivery."],
        searchKeywords: ["pending reminders", "future messages", "scheduled delivery list"],
        description:
            "List the messages you have scheduled, soonest first, one bounded page at a time. Every ID shown is complete and can be cancelled.",
        parameters: schedulingScheduleToolPageQuerySchema,
        returnType: schedulingSchedulePageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingScheduleToolPageQuery) =>
            await scheduling.listSchedulePage(ctx, agentId, input),
        toLLM: (page) => [{ type: "text", text: scheduling.formatSchedulePageForModel(page) }],
    });
}
