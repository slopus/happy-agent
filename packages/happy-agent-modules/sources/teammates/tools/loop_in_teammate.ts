import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { formatHappyMarkdownLink } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { taskLoopInReasonSchema } from "../../tasks/index.js";
import type { LoopInTarget, TeammatesModule } from "../TeammatesModule.js";

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

const BOT_DESCRIPTION =
    "Bring this bot to a teammate's attention by their user ID from list_teammates. It is marked new for them on every device with your reason, a one-sentence why, and comes back into their sidebar if they had hidden it. Nobody else sees a change. Write the returned mention link in your reply.";

/**
 * Add a teammate to this task and highlight it for them, whatever their auto-join setting; for a
 * bot, highlight the bot for them and show it in their sidebar again.
 */
export function loopInTeammateTool(teammates: TeammatesModule, to: LoopInTarget, agentId: string) {
    return defineAgentTool({
        name: "loop_in_teammate",
        defer: true,
        capabilities: ["See who is on the team and loop a teammate into this task."],
        searchKeywords: ["loop in", "add teammate", "invite to task", "notify teammate"],
        description:
            "botId" in to
                ? BOT_DESCRIPTION
                : [
                      "Loop a teammate into this task by their user ID from list_teammates. They join the task even when they turned automatic joining off, and it is marked new for them on every device with your reason.",
                      "",
                      "reason is one sentence the teammate reads, saying why this concerns them. Looping in someone already in the task highlights it for them again. Write the returned mention link in your reply so people see whom you looped in.",
                  ].join("\n"),
        parameters: loopInTeammateInputSchema,
        returnType: loopInTeammateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: LoopInTeammateInput) => {
            const result = await teammates.loopIn(ctx, {
                ...to,
                agentId,
                userId: input.userId,
                reason: input.reason,
            });
            return {
                userId: result.teammate.id,
                name: result.teammate.name,
                joined: result.joined,
                mention: formatHappyMarkdownLink(
                    { type: "reference", reference: { kind: "user", id: result.teammate.id } },
                    result.teammate.name,
                ),
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
