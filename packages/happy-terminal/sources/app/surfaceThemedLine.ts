import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";

/** Paints one panel line onto the theme's surface so the whole panel reads as a single card. */
export function surfaceThemedLine(content: string, width: number, theme: TerminalTheme): string {
    const restored = content.replaceAll(RESET, `${RESET}${theme.inputBackground}${theme.primary}`);
    const fitted = truncateToWidth(restored, width, "", true);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
    return `${theme.inputBackground}${theme.primary}${fitted}${padding}${RESET}`;
}
