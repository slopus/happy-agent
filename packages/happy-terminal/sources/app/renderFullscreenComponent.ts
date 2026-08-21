import type { Component } from "@earendil-works/pi-tui";

import { fitSelectionPanelToViewport } from "./createSelectionPanel.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";

export function renderFullscreenComponent(options: {
    component: Component;
    height: number;
    theme: TerminalTheme;
    width: number;
}): string[] {
    const height = Math.max(1, options.height);
    const width = Math.max(1, options.width);
    fitSelectionPanelToViewport(options.component, width, height);
    const lines = options.component.render(width).slice(0, height);
    const blank = `${options.theme.inputBackground}${options.theme.primary}${" ".repeat(width)}${RESET}`;
    while (lines.length < height) lines.push(blank);
    return lines;
}
