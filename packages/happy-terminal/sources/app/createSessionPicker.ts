import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { AgentCatalogEntry } from "../client/index.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { formatSessionPickerEntry, type SessionPickerEntry } from "./formatSessionPickerEntry.js";
import { surfaceThemedLine } from "./surfaceThemedLine.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";
const DEFAULT_VISIBLE_SESSIONS = 5;
const MIN_META_GAP = 2;

export interface CreateSessionPickerOptions {
    /** What Enter does to the highlighted session, such as "resume" or "fork". */
    confirmVerb: string;
    now?: () => number;
    onCancel: () => void;
    onSelect: (entry: AgentCatalogEntry) => void;
    agents: readonly AgentCatalogEntry[];
    showDirectory: boolean;
    subtitle: string;
    theme?: TerminalTheme;
    title: string;
}

export function createSessionPicker(options: CreateSessionPickerOptions): Component {
    return new SessionPicker(options);
}

/**
 * Presents saved sessions as a themed card of rich rows rather than a numbered prompt, so
 * resuming looks like the rest of Happy Terminal's startup screen.
 */
class SessionPicker implements Component {
    readonly #confirmVerb: string;
    readonly #entries: readonly SessionPickerEntry[];
    readonly #onCancel: () => void;
    readonly #onSelect: (entry: AgentCatalogEntry) => void;
    readonly #agents: readonly AgentCatalogEntry[];
    readonly #subtitle: string;
    readonly #theme: TerminalTheme;
    readonly #title: string;

    #maxVisible = DEFAULT_VISIBLE_SESSIONS;
    #scrollOffset = 0;
    #selectedIndex = 0;

    constructor(options: CreateSessionPickerOptions) {
        const now = (options.now ?? Date.now)();
        this.#confirmVerb = options.confirmVerb;
        this.#agents = options.agents;
        this.#entries = options.agents.map((entry) =>
            formatSessionPickerEntry(entry, { now, showDirectory: options.showDirectory }),
        );
        this.#onCancel = options.onCancel;
        this.#onSelect = options.onSelect;
        this.#subtitle = options.subtitle;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
        this.#title = options.title;
    }

    /** Shows as many rows as the terminal can hold, leaving room for the banner and chrome. */
    fitToViewport(_width: number, height: number): void {
        const rowsForSessions = height - 8;
        this.#maxVisible = Math.max(1, Math.floor(rowsForSessions / 3));
        this.#clampScroll();
    }

    invalidate(): void {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const contentWidth = Math.max(1, safeWidth - 4);
        const visible = this.#entries.slice(
            this.#scrollOffset,
            this.#scrollOffset + this.#maxVisible,
        );
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}${this.#title}${NOT_BOLD_OR_DIM}${this.#theme.primary}`,
            `  ${this.#theme.secondary}${this.#subtitle}${this.#theme.primary}`,
            "",
        ];
        visible.forEach((entry, index) => {
            if (index > 0) lines.push("");
            lines.push(...this.#renderEntry(entry, this.#scrollOffset + index, contentWidth));
        });
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}${this.#footer()}${this.#theme.primary}`,
            "",
        );
        return lines.map((line) => surfaceThemedLine(line, safeWidth, this.#theme));
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.#onCancel();
            return;
        }
        if (matchesKey(data, "up")) {
            this.#moveSelection(-1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.#moveSelection(1);
            return;
        }
        if (matchesKey(data, "enter")) {
            const entry = this.#agents[this.#selectedIndex];
            if (entry !== undefined) this.#onSelect(entry);
        }
    }

    #renderEntry(entry: SessionPickerEntry, index: number, contentWidth: number): string[] {
        const selected = index === this.#selectedIndex;
        const pointer = selected ? `${this.#theme.brand}❯${RESET} ` : "  ";
        const titleColor = selected
            ? `${this.#theme.brand}${BOLD}`
            : `${this.#theme.primary}${BOLD}`;
        const badge =
            entry.badge === undefined ? "" : ` ${this.#theme.accent}${entry.badge}${RESET}`;
        const meta = `${DIM}${this.#theme.secondary}${entry.meta}${RESET}`;
        const lines = [
            `  ${pointer}${this.#titleRow(
                `${titleColor}${entry.title}${NOT_BOLD_OR_DIM}${RESET}${badge}`,
                meta,
                contentWidth,
            )}`,
        ];
        if (entry.detail !== undefined) {
            lines.push(
                `      ${DIM}${this.#theme.secondary}${truncateToWidth(
                    entry.detail,
                    Math.max(1, contentWidth - 2),
                    "…",
                    false,
                )}${RESET}`,
            );
        }
        return lines;
    }

    /** Right-aligns the timestamp and context size, dropping them when the row is too narrow. */
    #titleRow(title: string, meta: string, contentWidth: number): string {
        const metaWidth = visibleWidth(meta);
        const titleBudget = contentWidth - metaWidth - MIN_META_GAP;
        if (titleBudget < 12) return truncateToWidth(title, contentWidth, "…", true);
        const fittedTitle = truncateToWidth(title, titleBudget, "…", true);
        const gap = " ".repeat(
            Math.max(MIN_META_GAP, contentWidth - visibleWidth(fittedTitle) - metaWidth),
        );
        return `${fittedTitle}${gap}${meta}`;
    }

    #footer(): string {
        const hidden = this.#entries.length - this.#maxVisible;
        const scroll = hidden > 0 ? ` ${this.#entries.length} agents.` : "";
        return `Use ↑/↓ to move, Enter to ${this.#confirmVerb}, Esc to cancel.${scroll}`;
    }

    #moveSelection(delta: number): void {
        if (this.#entries.length === 0) return;
        this.#selectedIndex = Math.min(
            this.#entries.length - 1,
            Math.max(0, this.#selectedIndex + delta),
        );
        this.#clampScroll();
    }

    #clampScroll(): void {
        const maxOffset = Math.max(0, this.#entries.length - this.#maxVisible);
        this.#scrollOffset = Math.min(maxOffset, this.#scrollOffset);
        if (this.#selectedIndex < this.#scrollOffset) {
            this.#scrollOffset = this.#selectedIndex;
        } else if (this.#selectedIndex >= this.#scrollOffset + this.#maxVisible) {
            this.#scrollOffset = this.#selectedIndex - this.#maxVisible + 1;
        }
    }
}

export function fitSessionPickerToViewport(
    component: Component,
    width: number,
    height: number,
): void {
    if (component instanceof SessionPicker) component.fitToViewport(width, height);
}
