import { truncateToWidth } from "@earendil-works/pi-tui";

import type { CompletedTurnStats } from "./CompletedTurn.js";
import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderCompletedTurnStats(
    stats: CompletedTurnStats,
    width: number,
    usageSummary?: string,
): string {
    const parts = [`Worked for ${formatActivityElapsedTime(stats.elapsedMs)}`];
    if (stats.toolCount > 0) {
        parts.push(`${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`);
    }
    if (stats.fileCount > 0) {
        parts.push(`${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`);
        parts.push(`+${stats.additions} -${stats.deletions}`);
    }
    if (usageSummary !== undefined) parts.push(usageSummary);
    return truncateToWidth(`${DIM}• ${parts.join(" · ")}${RESET}`, Math.max(1, width), "", true);
}
