import { truncateToWidth } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NOT_BOLD = "\x1b[22m";
const DIM = "\x1b[2m";

export function renderBackgroundTerminalCompletion(command: string, width: number): string {
    const safeCommand = sanitizeTerminalText(command).replaceAll("\n", " ");
    return truncateToWidth(
        `${DIM}• ${BOLD}Background terminal completed${NOT_BOLD}${safeCommand.length === 0 ? "" : ` · ${safeCommand}`}${RESET}`,
        Math.max(1, width),
        "",
        true,
    );
}
