import { truncateToWidth } from "@earendil-works/pi-tui";

import type { NoticeChild } from "./NoticeChild.js";
import { renderChildRows } from "./renderChildRows.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

const BOLD = "\x1b[1m";
const NOT_BOLD_OR_DIM = "\x1b[22m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderNoticeWithChildren(options: {
    readonly children: readonly NoticeChild[];
    readonly color: string;
    readonly title: string;
    readonly width: number;
}): string[] {
    const width = Math.max(1, Math.floor(options.width));
    const safeTitle = sanitizeTerminalText(options.title).replace(/\s+/gu, " ").trim();
    const lines = [
        truncateToWidth(
            `${options.color}•${RESET} ${BOLD}${safeTitle}${NOT_BOLD_OR_DIM}`,
            width,
            "",
            true,
        ),
    ];
    lines.push(
        ...renderChildRows(
            options.children.map((child) => {
                const label = sanitizeTerminalText(child.label).replace(/\s+/gu, " ").trim();
                const reason = sanitizeTerminalText(child.reason).replace(/\s+/gu, " ").trim();
                return { text: `${label} — ${reason}` };
            }),
            { afterMarker: RESET, markerStyle: DIM, width },
        ),
    );

    return lines;
}
