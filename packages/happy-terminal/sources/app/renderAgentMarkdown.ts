import { Markdown, truncateToWidth, type DefaultTextStyle } from "@earendil-works/pi-tui";

import { createAgentMarkdownTheme } from "./createAgentMarkdownTheme.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";

export interface RenderAgentMarkdownOptions {
    text: string;
    width: number;
    cwd: string;
    theme?: TerminalTheme;
}

export function renderAgentMarkdown(options: RenderAgentMarkdownOptions): string[] {
    const width = Math.max(1, options.width);
    const theme = options.theme ?? DEFAULT_TERMINAL_THEME;
    const text = sanitizeTerminalText(options.text).trimEnd();

    if (text.length === 0) {
        return [];
    }

    const defaultTextStyle: DefaultTextStyle = {
        color: (value) => `${theme.primary}${value}${RESET}`,
    };
    const markdown = new Markdown(text, 0, 0, createAgentMarkdownTheme(theme), defaultTextStyle, {
        preserveBackslashEscapes: true,
        preserveOrderedListMarkers: true,
    });

    const rendered = markdown.render(width);
    if (rendered.length === 0) {
        return [];
    }

    return rendered.map((line) => truncateToWidth(line, width, "", true));
}
