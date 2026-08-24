import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalModule } from "../GoalModule.js";

/** The durable model tool that clears the owning agent's goal. */
export function clearGoalTool(goals: GoalModule, agentId: string) {
    return defineAgentTool({
        name: "clear_goal",
        defer: true,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        searchKeywords: ["abandon goal", "clear persistent objective", "remove goal"],
        description:
            "Clear the persistent goal when the user explicitly abandons it. Use update_goal with blocked when work cannot continue but the objective should remain recorded.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ cleared: Type.Boolean() }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({ cleared: await goals.clearGoal(ctx, agentId) }),
        toLLM: ({ cleared }) => [
            {
                type: "text",
                text: cleared ? "Goal cleared." : "This agent had no goal to clear.",
            },
        ],
    });
}
