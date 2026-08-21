import { truncateToWidth } from "@earendil-works/pi-tui";

import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { formatCompactTokens } from "./formatCompactTokens.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderSubagentSummary(options: {
    count: number;
    elapsedMs: number;
    totalTokens: number;
    width: number;
}): string | undefined {
    if (options.count === 0) return undefined;

    const plural = options.count === 1 ? "" : "s";
    const summary = `  ${String(options.count)} agent${plural} running · /agents to view · ${formatActivityElapsedTime(options.elapsedMs)} · ${formatCompactTokens(options.totalTokens)} context tokens`;
    return truncateToWidth(`${DIM}${summary}${RESET}`, Math.max(1, options.width), "", true);
}
