import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { taskLoopInReasonSchema } from "../../tasks/index.js";
import type { TeammatesModule } from "../TeammatesModule.js";

const notifyTeammateInputSchema = Type.Object(
    {
        userId: cuid2Schema,
        reason: taskLoopInReasonSchema,
    },
    { additionalProperties: false },
);
type NotifyTeammateInput = Static<typeof notifyTeammateInputSchema>;

const notifyTeammateResultSchema = Type.Object(
    {
        userId: Type.String(),
        name: Type.String(),
        delivered: Type.Boolean(),
        mention: Type.String(),
    },
    { additionalProperties: false },
);

/** Tell a teammate's Focus that this task concerns them; their Focus decides whether to add it. */
export function notifyTeammateTool(teammates: TeammatesModule, taskId: string) {
    return defineAgentTool({
        name: "notify_teammate",
        defer: true,
        capabilities: ["See who is on the team and tell a teammate about this task."],
        searchKeywords: ["loop in", "mention teammate", "tell teammate", "notify teammate"],
        description: [
            "Tell a teammate about this task, by their user ID from list_teammates. Their own Focus hears your reason and decides, from what they do and follow, whether to add the task to their sidebar and mark it new for them.",
            "",
            "reason is one sentence saying why this concerns them. Write the returned mention tag in your reply so people see whom you told.",
        ].join("\n"),
        parameters: notifyTeammateInputSchema,
        returnType: notifyTeammateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: NotifyTeammateInput) => {
            const result = await teammates.notify(ctx, {
                taskId,
                userId: input.userId,
                reason: input.reason,
            });
            return {
                userId: result.teammate.id,
                name: result.teammate.name,
                delivered: result.delivered,
                mention: formatHappyReferenceTag({ kind: "user", id: result.teammate.id }),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.delivered
                    ? `Told ${result.name}'s Focus; it decides whether to add this task for them. Mention them in your reply as ${result.mention}.`
                    : `${result.name} does not use Focus, so nothing was added for them. Mention them in your reply as ${result.mention} so the person can share the task.`,
            },
        ],
    });
}
