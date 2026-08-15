import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { withGoalToolContext } from "../impl/goalKV.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The durable tool that reads its owning agent's goal. */
export function getGoalTool(goals: GoalFeature, agentId: string, maxOutputCharacters: number) {
    return defineAgentTool({
        name: "get_goal",
        description: "Get the persistent goal for this agent, including its objective and status.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ goal: Type.Union([sessionGoalSchema, Type.Null()]) }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const toolCtx = withGoalToolContext(ctx);
            return { goal: (await goals.goal(toolCtx, agentId)) ?? null };
        },
        toLLM: ({ goal }) => [
            { type: "text", text: formatGoalForModel(goal, maxOutputCharacters) },
        ],
    });
}
