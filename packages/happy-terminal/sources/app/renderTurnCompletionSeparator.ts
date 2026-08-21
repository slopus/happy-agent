import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderTurnCompletionSeparator(
    elapsedMs: number,
    width: number,
    usageSummary?: string,
): string {
    const safeWidth = Math.max(1, width);
    const details = [`Worked for ${formatActivityElapsedTime(elapsedMs)}`];
    if (usageSummary !== undefined) details.push(usageSummary);
    const label = `─ ${details.join(" · ")} ─`;
    const rule = "─".repeat(Math.max(0, safeWidth - visibleWidth(label)));
    return truncateToWidth(`${DIM}${label}${rule}${RESET}`, safeWidth, "", true);
}
