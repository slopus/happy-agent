import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { taskLoopInReasonSchema } from "../../tasks/index.js";
import type { TeammatesModule } from "../TeammatesModule.js";

const loopInTeammateInputSchema = Type.Object(
    {
        userId: cuid2Schema,
        reason: taskLoopInReasonSchema,
    },
    { additionalProperties: false },
);
type LoopInTeammateInput = Static<typeof loopInTeammateInputSchema>;

const loopInTeammateResultSchema = Type.Object(
    {
        userId: Type.String(),
        name: Type.String(),
        joined: Type.Boolean(),
        mention: Type.String(),
    },
    { additionalProperties: false },
);

/** Add a teammate to this task and highlight it for them, whatever their auto-join setting. */
export function loopInTeammateTool(teammates: TeammatesModule, taskId: string, agentId: string) {
    return defineAgentTool({
        name: "loop_in_teammate",
        defer: false,
        capabilities: ["See who is on the team and loop a teammate into this task."],
        searchKeywords: ["loop in", "add teammate", "invite to task", "notify teammate"],
        description: [
            "Loop a teammate into this task by their user ID from list_teammates. They join the task even when they turned automatic joining off, and it is marked new for them on every device with your reason.",
            "",
            "reason is one sentence the teammate reads, saying why this concerns them. Looping in someone already in the task highlights it for them again. Write the returned mention tag in your reply so people see whom you looped in.",
        ].join("\n"),
        parameters: loopInTeammateInputSchema,
        returnType: loopInTeammateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: LoopInTeammateInput) => {
            const result = await teammates.loopIn(ctx, {
                taskId,
                agentId,
                userId: input.userId,
                reason: input.reason,
            });
            return {
                userId: result.teammate.id,
                name: result.teammate.name,
                joined: result.joined,
                mention: formatHappyReferenceTag({ kind: "user", id: result.teammate.id }),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.joined ? "Looped in" : "Highlighted this task again for"} ${result.name}. Mention them in your reply as ${result.mention}.`,
            },
        ],
    });
}
