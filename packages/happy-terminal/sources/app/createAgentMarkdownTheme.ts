import type { MarkdownTheme } from "@earendil-works/pi-tui";

import { highlightAgentCode } from "./highlightAgentCode.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const FG_RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const NOT_BOLD = "\x1b[22m";
const ITALIC = "\x1b[3m";
const NOT_ITALIC = "\x1b[23m";
const STRIKETHROUGH = "\x1b[9m";
const NOT_STRIKETHROUGH = "\x1b[29m";
const UNDERLINE = "\x1b[4m";
const NOT_UNDERLINE = "\x1b[24m";

export function createAgentMarkdownTheme(theme: TerminalTheme): MarkdownTheme {
    return {
        heading: (text) => style(theme.primary, text),
        link: (text) => style(theme.accent, text.replaceAll(theme.primary, theme.accent)),
        linkUrl: (text) => style(theme.secondary, text),
        code: (text) => style(theme.accent, text),
        codeBlock: (text) => style(theme.primary, text),
        codeBlockBorder: (text) => style(theme.secondary, text),
        quote: (text) => style(theme.success, text),
        quoteBorder: (text) => style(theme.success, text),
        hr: (text) => style(theme.secondary, text),
        listBullet: (text) => style(theme.primary, text),
        bold: (text) => `${BOLD}${text}${NOT_BOLD}`,
        italic: (text) => `${ITALIC}${text}${NOT_ITALIC}`,
        strikethrough: (text) => `${STRIKETHROUGH}${text}${NOT_STRIKETHROUGH}`,
        underline: (text) => `${UNDERLINE}${text}${NOT_UNDERLINE}`,
        highlightCode: highlightAgentCode,
        codeBlockIndent: "  ",
    };
}

function style(ansi: string, text: string): string {
    return `${ansi}${text}${NOT_BOLD}${FG_RESET}`;
}
