import { MAX_GOAL_OBJECTIVE_CHARS, goalObjectiveSchema } from "../SessionGoal.js";
import { Value } from "@sinclair/typebox/value";

export { MAX_GOAL_OBJECTIVE_CHARS };

/** The objective as it will be stored, or a refusal explaining why it cannot be. */
export function normalizeGoalObjective(objective: string): string {
    const normalized = objective.trim();
    if (normalized.length === 0) {
        throw new Error("Goal objective must not be empty.");
    }
    if (!Value.Check(goalObjectiveSchema, normalized)) {
        throw new Error(
            `Goal objective must be ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")} characters or fewer.`,
        );
    }
    return normalized;
}
