import type { SessionGoal } from "../SessionGoal.js";

/** Format a goal without allowing a legal maximum objective to exceed the model budget. */
export function formatGoalForModel(goal: SessionGoal | null, maxOutputCharacters: number): string {
    if (goal === null) return "This agent has no goal.";
    const prefix = `Goal status: ${goal.status}\nObjective: `;
    if (prefix.length >= maxOutputCharacters) {
        return goal.status.slice(0, Math.max(1, maxOutputCharacters));
    }
    const remaining = maxOutputCharacters - prefix.length;
    if (goal.objective.length <= remaining) return `${prefix}${goal.objective}`;
    if (remaining <= 1) return `${prefix}${goal.objective.slice(0, remaining)}`;
    return `${prefix}${goal.objective.slice(0, remaining - 1)}…`;
}
