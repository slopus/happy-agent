import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalModule } from "../GoalModule.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The durable tool that reads its owning agent's goal. */
export function getGoalTool(goals: GoalModule, agentId: string, maxOutputCharacters: number) {
    return defineAgentTool({
        name: "get_goal",
        defer: true,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        searchKeywords: ["inspect current goal", "goal status", "read objective"],
        description: "Get the persistent goal for this agent, including its objective and status.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ goal: Type.Union([sessionGoalSchema, Type.Null()]) }),
        durable: true,
        reloadable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({ goal: (await goals.goal(ctx, agentId)) ?? null }),
        toLLM: ({ goal }) => [
            { type: "text", text: formatGoalForModel(goal, maxOutputCharacters) },
        ],
    });
}
