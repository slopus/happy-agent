import type { SubagentSummary } from "../protocol/index.js";

export function subagentElapsedMs(subagent: SubagentSummary, now: number): number {
    return (
        (subagent.elapsedMs ?? 0) +
        (subagent.activeSince === undefined ? 0 : Math.max(0, now - subagent.activeSince))
    );
}
