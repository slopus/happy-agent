import {
    CURSOR_MARKER,
    Input,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";

import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";

export interface CreateSecretInputPanelOptions {
    label: string;
    masked?: boolean;
    onCancel: () => void;
    onSubmit: (value: string) => void;
    subtitle: string;
    theme?: TerminalTheme;
    title: string;
}

export function createSecretInputPanel(options: CreateSecretInputPanelOptions): Component {
    return new SecretInputPanel(options);
}

class SecretInputPanel implements Component {
    readonly #input = new Input();
    readonly #label: string;
    readonly #masked: boolean;
    readonly #subtitle: string;
    readonly #theme: TerminalTheme;
    readonly #title: string;

    constructor(options: CreateSecretInputPanelOptions) {
        this.#label = sanitizeTerminalText(options.label);
        this.#masked = options.masked === true;
        this.#subtitle = sanitizeTerminalText(options.subtitle);
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
        this.#title = sanitizeTerminalText(options.title);
        this.#input.focused = true;
        this.#input.onEscape = options.onCancel;
        this.#input.onSubmit = options.onSubmit;
    }

    handleInput(data: string): void {
        this.#input.handleInput(data);
    }

    invalidate(): void {
        this.#input.invalidate();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const contentWidth = Math.max(1, safeWidth - 4);
        const value = this.#input.getValue();
        const displayValue = this.#masked
            ? "*".repeat([...value].length)
            : sanitizeTerminalText(value);
        const prompt = `${this.#label}: `;
        const valueWidth = Math.max(1, contentWidth - visibleWidth(prompt) - 1);
        const visibleValue = truncateToWidth(displayValue, valueWidth, "", false);
        const inputLine = `  ${this.#theme.secondary}${prompt}${this.#theme.primary}${visibleValue}${CURSOR_MARKER}\x1b[7m \x1b[27m`;
        const subtitleLines = wrapTextWithAnsi(this.#subtitle, Math.max(1, safeWidth - 2));
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}${this.#title}${NOT_BOLD_OR_DIM}${this.#theme.primary}`,
            ...subtitleLines.map(
                (line) => `  ${this.#theme.secondary}${line}${this.#theme.primary}`,
            ),
            "",
            inputLine,
            "",
            `  ${DIM}${this.#theme.secondary}Enter to continue, Esc to cancel.${this.#theme.primary}`,
            "",
        ];

        return lines.map((line) => this.#surfaceLine(line, safeWidth));
    }

    #surfaceLine(content: string, width: number): string {
        const restored = content.replaceAll(
            RESET,
            `${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
        );
        const fitted = truncateToWidth(restored, width, "", true);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        return `${this.#theme.inputBackground}${this.#theme.primary}${fitted}${padding}${RESET}`;
    }
}
