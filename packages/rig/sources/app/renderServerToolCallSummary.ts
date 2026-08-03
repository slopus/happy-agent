import { truncateToWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * Renders the one row that stands for everything the provider is running on its own backend.
 *
 * Several hosted calls can be open at once, and each one lasts only as long as the response that
 * contains it, so they share a single truncated row that names the first and counts the rest.
 */
export function renderServerToolCallSummary(
    labels: readonly string[],
    width: number,
): string | undefined {
    const first = labels[0];
    if (first === undefined) return undefined;

    const remaining = labels.length - 1;
    const summary =
        remaining === 0 ? `  ${first}` : `  ${first} · ${String(remaining)} more running`;
    return truncateToWidth(`${DIM}${summary}${RESET}`, Math.max(1, width), "", true);
}
