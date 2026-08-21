import type { SubagentSummary } from "../protocol/index.js";

export function sortSubagentsForDisplay(
    subagents: readonly SubagentSummary[],
): readonly SubagentSummary[] {
    return subagents
        .map((subagent, index) => ({ index, subagent }))
        .sort(
            (left, right) =>
                activityGroup(left.subagent) - activityGroup(right.subagent) ||
                left.index - right.index,
        )
        .map(({ subagent }) => subagent);
}

function activityGroup(subagent: SubagentSummary): number {
    return subagent.status === "running" ||
        subagent.status === "queued" ||
        subagent.status === "suspended"
        ? 0
        : 1;
}
