import type { EditorTheme } from "@earendil-works/pi-tui";

import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function createEditorTheme(theme: TerminalTheme): EditorTheme {
    return {
        borderColor: (text) => text,
        selectList: {
            selectedPrefix: (text) => text,
            selectedText: (text) => `${theme.brand}${text}${RESET}${theme.primary}`,
            description: (text) => `${DIM}${theme.secondary}${text}${RESET}${theme.primary}`,
            scrollInfo: (text) => `${DIM}${theme.secondary}${text}${RESET}${theme.primary}`,
            noMatch: (text) => `${theme.secondary}${text}${RESET}${theme.primary}`,
        },
    };
}
