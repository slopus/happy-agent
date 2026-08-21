import { truncateToWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderBackgroundTerminalSummary(count: number, width: number): string | undefined {
    if (count === 0) return undefined;

    const plural = count === 1 ? "" : "s";
    const summary = `  ${String(count)} background terminal${plural} running · /ps to view · /stop to close`;
    return truncateToWidth(`${DIM}${summary}${RESET}`, Math.max(1, width), "", true);
}
