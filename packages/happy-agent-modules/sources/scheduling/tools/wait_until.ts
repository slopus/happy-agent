import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingWaitResultSchema,
    schedulingWaitUntilToolInputSchema,
    type SchedulingWaitUntilToolInput,
} from "../Scheduling.js";

export function waitUntilTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "wait_until",
        defer: true,
        capabilities: ["Wait and schedule durable messages for future delivery."],
        searchKeywords: ["pause until date", "wait until timestamp", "future time"],
        description:
            "Pause until a date at most 24 hours away. Write it as ISO 8601, RFC 2822, or a Unix timestamp in seconds or milliseconds; a date already past returns at once. The wait survives a restart, and any new message in this chat ends it early.",
        parameters: schedulingWaitUntilToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        steerable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitUntilToolInput, call) =>
            await scheduling.waitUntil(ctx, agentId, { ...input, id: call.id }),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}
