import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { withGoalToolContext } from "../impl/goalKV.js";

/** The durable model tool that clears the owning agent's goal. */
export function clearGoalTool(goals: GoalFeature, agentId: string) {
    return defineAgentTool({
        name: "clear_goal",
        description:
            "Clear the persistent goal when the user explicitly abandons it. Use update_goal with blocked when work cannot continue but the objective should remain recorded.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ cleared: Type.Boolean() }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const toolCtx = withGoalToolContext(ctx);
            return { cleared: await goals.clearGoal(toolCtx, agentId) };
        },
        toLLM: ({ cleared }) => [
            {
                type: "text",
                text: cleared ? "Goal cleared." : "This agent had no goal to clear.",
            },
        ],
    });
}
