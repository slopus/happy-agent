import type { SubagentSummary } from "../protocol/index.js";

const LABELS = {
    aborted: "Stopped",
    archived: "Archived",
    completed: "Completed",
    error: "Failed",
    idle: "Idle",
    queued: "Queued",
    running: "Running",
    suspended: "Suspended",
} satisfies Record<SubagentSummary["status"], string>;

export function humanizeSubagentStatus(status: SubagentSummary["status"]): string {
    return LABELS[status];
}
