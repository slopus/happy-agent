import { truncateToWidth } from "@earendil-works/pi-tui";

import { renderChildRows } from "./renderChildRows.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const PREVIEW_LINE_LIMIT = 3;

export function renderPendingSteeringMessages(
    messages: readonly string[],
    width: number,
): string[] {
    if (messages.length === 0) return [];

    const safeWidth = Math.max(1, width);
    const lines = [
        truncateToWidth(
            `${DIM} • Messages to be submitted after next tool call (esc to send now)${RESET}`,
            safeWidth,
            "",
            true,
        ),
    ];
    lines.push(
        ...renderChildRows(
            messages.map((message) => ({
                lineLimit: PREVIEW_LINE_LIMIT,
                prefix: DIM,
                suffix: RESET,
                text: sanitizeTerminalText(message),
            })),
            { afterMarker: RESET, markerStyle: DIM, width: safeWidth },
        ),
    );
    return lines;
}
