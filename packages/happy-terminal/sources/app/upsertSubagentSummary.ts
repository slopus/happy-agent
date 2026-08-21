import type { SubagentSummary } from "../protocol/index.js";

export function upsertSubagentSummary(
    subagents: readonly SubagentSummary[],
    next: SubagentSummary,
): readonly SubagentSummary[] {
    const existing = subagents.findIndex((subagent) => subagent.id === next.id);
    if (existing < 0) return [...subagents, next];
    return subagents.map((subagent, index) => (index === existing ? next : subagent));
}
