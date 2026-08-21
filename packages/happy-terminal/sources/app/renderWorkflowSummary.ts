import { truncateToWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderWorkflowSummary(count: number, width: number): string | undefined {
    if (count === 0) return undefined;

    const plural = count === 1 ? "" : "s";
    const summary = `  ${String(count)} workflow${plural} running · /workflows to view`;
    return truncateToWidth(`${DIM}${summary}${RESET}`, Math.max(1, width), "", true);
}
