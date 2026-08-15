import type { SessionSummary } from "../index.js";
import type { SessionTerminalTracker } from "../../terminal/SessionTerminalTracker.js";

export function sessionSummaryWithTerminalPresence(
    summary: SessionSummary,
    terminals: SessionTerminalTracker,
): SessionSummary {
    const presentedSummary =
        summary.unread !== undefined && terminals.hasFocusedTerminal(summary.id)
            ? withoutUnread(summary)
            : summary;
    if (summary.status === "archived") {
        return { ...presentedSummary, archived: true };
    }
    if (
        terminals.hasConnectedTerminal(summary.id) ||
        summary.status === "queued" ||
        summary.status === "running"
    ) {
        return presentedSummary;
    }
    return { ...presentedSummary, status: "idle" };
}

function withoutUnread(summary: SessionSummary): SessionSummary {
    const { unread: _, ...readSummary } = summary;
    return readSummary;
}
