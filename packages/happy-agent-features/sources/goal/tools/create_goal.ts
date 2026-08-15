import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { GoalFeature } from "../GoalFeature.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { withGoalToolContext } from "../impl/goalKV.js";
import { goalObjectiveSchema, sessionGoalSchema, type SessionGoal } from "../SessionGoal.js";

/** The durable tool that starts a goal for its owning agent. */
export function createGoalTool(
    goals: GoalFeature,
    agentId: string,
    maxOutputCharacters: number,
    observeActiveLifecycle: (ctx: Context, goal: SessionGoal) => Promise<void>,
) {
    return defineAgentTool({
        name: "create_goal",
        description: `Create a persistent goal only when the user explicitly asks for long-running goal execution.
Do not infer a goal from an ordinary task. A new goal cannot replace an unfinished goal.`,
        parameters: Type.Object(
            {
                objective: goalObjectiveSchema,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { objective }) => {
            const toolCtx = withGoalToolContext(ctx);
            const goal = await goals.setGoal(toolCtx, agentId, objective);
            await observeActiveLifecycle(toolCtx, goal);
            return { goal };
        },
        toLLM: ({ goal }) => [
            { type: "text", text: formatGoalForModel(goal, maxOutputCharacters) },
        ],
    });
}
