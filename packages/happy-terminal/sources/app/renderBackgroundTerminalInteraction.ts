import { truncateToWidth } from "@earendil-works/pi-tui";

import type { BackgroundTerminalInteractionPresentation } from "../protocol/index.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { renderChildRows } from "./renderChildRows.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

export function renderBackgroundTerminalInteraction(
    interaction: BackgroundTerminalInteractionPresentation,
    width: number,
    review?: string,
): string[] {
    if (interaction.input.length === 0) return [];

    const prefix = `${DIM}↳${RESET} `;
    const label = "Interacted with background terminal";
    const command = sanitizeTerminalText(interaction.command).replaceAll("\n", " ");
    const header = `${prefix}${BOLD}${label}${RESET}${command.length === 0 ? "" : `${DIM} · ${command}${RESET}`}`;
    const lines = [truncateToWidth(header, Math.max(1, width), "", true)];

    const input = sanitizeTerminalText(interaction.input).replaceAll("\r", "");
    const childRows = [
        ...(review === undefined ? [] : [{ prefix: DIM, suffix: RESET, text: review }]),
        ...(input.length === 0 ? [] : [{ text: input }]),
    ];
    if (childRows.length === 0) return lines;
    lines.push(
        ...renderChildRows(childRows, {
            afterMarker: RESET,
            markerStyle: DIM,
            width,
        }),
    );
    return lines;
}
