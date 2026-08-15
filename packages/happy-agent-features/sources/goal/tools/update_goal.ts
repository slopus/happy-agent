import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { withGoalToolContext } from "../impl/goalKV.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The durable model tool that marks a goal complete or blocked. */
export function updateGoalTool(goals: GoalFeature, agentId: string, maxOutputCharacters: number) {
    return defineAgentTool({
        name: "update_goal",
        description: `Mark the persistent goal complete or blocked.
Use complete only when the full objective is achieved and verified with no required work remaining.
Use blocked only when meaningful progress cannot continue without user input or an external state change.
Pausing, resuming, and clearing a goal are controlled by the user.`,
        parameters: Type.Object(
            {
                status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
                    description: "The terminal status for the current goal.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { status }) => {
            const toolCtx = withGoalToolContext(ctx);
            return { goal: await goals.changeGoalStatus(toolCtx, agentId, status) };
        },
        toLLM: ({ goal }) => [
            {
                type: "text",
                text: formatGoalForModel(goal, maxOutputCharacters),
            },
        ],
    });
}
