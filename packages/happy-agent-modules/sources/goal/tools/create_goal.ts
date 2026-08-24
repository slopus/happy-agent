import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { GoalModule } from "../GoalModule.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { goalObjectiveSchema, sessionGoalSchema, type SessionGoal } from "../SessionGoal.js";

/** The durable tool that starts a goal for its owning agent. */
export function createGoalTool(
    goals: GoalModule,
    agentId: string,
    maxOutputCharacters: number,
    observeActiveLifecycle: (ctx: Context, goal: SessionGoal, lifecycleId: string) => Promise<void>,
) {
    return defineAgentTool({
        name: "create_goal",
        defer: true,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        searchKeywords: [
            "start persistent goal",
            "long-running objective",
            "continue autonomously",
        ],
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
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { objective }, call) =>
            await ctx.inTx(async (txCtx) => {
                const activation = await goals.setGoal(txCtx, agentId, objective, call.id);
                await observeActiveLifecycle(txCtx, activation.goal, activation.lifecycleId);
                return { goal: activation.goal };
            }),
        toLLM: ({ goal }) => [
            { type: "text", text: formatGoalForModel(goal, maxOutputCharacters) },
        ],
    });
}
