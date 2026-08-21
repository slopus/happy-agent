import {
    matchesKey,
    wrapTextWithAnsi,
    type Component,
    type SelectItem,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { SelectionList } from "./SelectionList.js";
import { surfaceThemedLine } from "./surfaceThemedLine.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";
const DEFAULT_VISIBLE_LINES = 12;

export interface CreateSelectionPanelOptions {
    cancelDisabled?: boolean;
    title: string;
    subtitle: string;
    items: readonly SelectItem[];
    selectedValue?: string;
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
    theme?: TerminalTheme;
}

export function createSelectionPanel(options: CreateSelectionPanelOptions): Component {
    return new SelectionPanel(options);
}

class SelectionPanel implements Component {
    readonly #cancelDisabled: boolean;
    readonly #items: SelectItem[];
    readonly #list: SelectionList;
    readonly #onCancel: () => void;
    readonly #onSelect: (item: SelectItem) => void;
    readonly #subtitle: string;
    readonly #title: string;
    readonly #theme: TerminalTheme;
    #viewportHeight: number | undefined;

    constructor(options: CreateSelectionPanelOptions) {
        this.#cancelDisabled = options.cancelDisabled === true;
        this.#title = sanitizeTerminalText(options.title);
        this.#subtitle = sanitizeTerminalText(options.subtitle);
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
        this.#items = options.items.map((item) => ({
            ...item,
            label: sanitizeTerminalText(item.label),
            ...(item.description === undefined
                ? {}
                : { description: sanitizeTerminalText(item.description) }),
        }));
        this.#onSelect = options.onSelect;
        this.#onCancel = options.onCancel;
        this.#list = this.#createList(DEFAULT_VISIBLE_LINES);

        const selectedIndex = options.items.findIndex(
            (item) => item.value === options.selectedValue,
        );
        if (selectedIndex >= 0) {
            this.#list.setSelectedIndex(selectedIndex);
        }
    }

    fitToViewport(_width: number, height: number): void {
        this.#viewportHeight = Math.max(1, height);
    }

    invalidate(): void {
        this.#list.invalidate();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const contentWidth = Math.max(1, safeWidth - 2);
        const titleLines = wrapTextWithAnsi(this.#title, contentWidth);
        const subtitleLines = wrapTextWithAnsi(this.#subtitle, contentWidth);
        const styledTitle = titleLines.map(
            (line) =>
                `  ${this.#theme.brand}${BOLD}${line}${NOT_BOLD_OR_DIM}${this.#theme.primary}`,
        );
        const styledSubtitle = subtitleLines.map(
            (line) => `  ${this.#theme.secondary}${line}${this.#theme.primary}`,
        );
        const listWidth = Math.max(1, safeWidth - 4);
        const fullChromeRows = titleLines.length + subtitleLines.length + 5;
        let lines: string[];
        if (this.#viewportHeight === undefined || this.#viewportHeight >= fullChromeRows + 1) {
            this.#list.setMaxVisibleLines(
                this.#viewportHeight === undefined
                    ? DEFAULT_VISIBLE_LINES
                    : this.#viewportHeight - fullChromeRows,
            );
            lines = [
                "",
                ...styledTitle,
                ...styledSubtitle,
                "",
                ...this.#list.render(listWidth).map((line) => `  ${line}`),
                "",
                `  ${DIM}${this.#theme.secondary}${
                    this.#cancelDisabled
                        ? "Use ↑/↓ to move and Enter to select."
                        : "Use ↑/↓ to move, Enter to select, Esc to cancel."
                }${this.#theme.primary}`,
                "",
            ];
        } else {
            const headers = [...styledTitle, ...styledSubtitle].slice(
                0,
                Math.max(0, this.#viewportHeight - 1),
            );
            this.#list.setMaxVisibleLines(Math.max(1, this.#viewportHeight - headers.length));
            lines = [...headers, ...this.#list.render(listWidth).map((line) => `  ${line}`)];
        }

        return lines.map((line) => surfaceThemedLine(line, safeWidth, this.#theme));
    }

    handleInput(data: string): void {
        if (this.#cancelDisabled && matchesKey(data, "escape")) return;
        this.#list.handleInput(data);
    }

    #createList(maxVisibleLines: number): SelectionList {
        const list = new SelectionList(this.#items, maxVisibleLines, {
            selectedText: (text) => `${this.#theme.brand}${text}${RESET}${this.#theme.primary}`,
            description: (text) => `${DIM}${this.#theme.secondary}${text}${RESET}`,
            scrollInfo: (text) => `${DIM}${this.#theme.secondary}${text}${RESET}`,
        });
        list.onSelect = this.#onSelect;
        list.onCancel = this.#onCancel;
        return list;
    }
}

export function fitSelectionPanelToViewport(
    component: Component,
    width: number,
    height: number,
): void {
    if (component instanceof SelectionPanel) component.fitToViewport(width, height);
}
