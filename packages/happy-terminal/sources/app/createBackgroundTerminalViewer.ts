import {
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";

import type { BashSessionSnapshot } from "../protocol/index.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";

export interface BackgroundTerminalViewer extends Component {
    setError(message: string | undefined): void;
    update(snapshot: BashSessionSnapshot): void;
}

export function createBackgroundTerminalViewer(options: {
    command: string;
    cwd: string;
    height: () => number;
    onCancel: () => void;
    onRequestRender: () => void;
    onStop: () => Promise<BashSessionSnapshot | undefined>;
    theme?: TerminalTheme;
}): BackgroundTerminalViewer {
    return new BackgroundTerminalViewerComponent(options);
}

class BackgroundTerminalViewerComponent implements BackgroundTerminalViewer {
    readonly #command: string;
    readonly #cwd: string;
    #error: string | undefined;
    readonly #height: () => number;
    readonly #onCancel: () => void;
    readonly #onRequestRender: () => void;
    readonly #onStop: () => Promise<BashSessionSnapshot | undefined>;
    #pageSize = 1;
    #scrollFromBottom = 0;
    #snapshot: BashSessionSnapshot | undefined;
    #stopping = false;
    readonly #theme: TerminalTheme;

    constructor(options: {
        command: string;
        cwd: string;
        height: () => number;
        onCancel: () => void;
        onRequestRender: () => void;
        onStop: () => Promise<BashSessionSnapshot | undefined>;
        theme?: TerminalTheme;
    }) {
        this.#command = options.command;
        this.#cwd = options.cwd;
        this.#height = options.height;
        this.#onCancel = options.onCancel;
        this.#onRequestRender = options.onRequestRender;
        this.#onStop = options.onStop;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
    }

    setError(message: string | undefined): void {
        this.#error = message;
    }

    update(snapshot: BashSessionSnapshot): void {
        this.#snapshot = snapshot;
        this.#error = undefined;
    }

    invalidate(): void {}

    handleInput(data: string): void {
        if (data === "\x1b" || data === "\r" || data === "q") {
            this.#onCancel();
            return;
        }
        if (data === "x" && this.#snapshot?.status === "running" && !this.#stopping) {
            this.#stopping = true;
            this.#onRequestRender();
            void this.#onStop()
                .then((snapshot) => {
                    if (snapshot !== undefined) this.update(snapshot);
                })
                .catch((error: unknown) => {
                    this.#error = error instanceof Error ? error.message : String(error);
                })
                .finally(() => {
                    this.#stopping = false;
                    this.#onRequestRender();
                });
            return;
        }

        const previous = this.#scrollFromBottom;
        if (data === "\x1b[A") this.#scrollFromBottom += 1;
        else if (data === "\x1b[B") this.#scrollFromBottom = Math.max(0, previous - 1);
        else if (data === "\x1b[5~" || data === "\x15") {
            this.#scrollFromBottom += Math.max(1, this.#pageSize - 1);
        } else if (data === "\x1b[6~" || data === "\x04") {
            this.#scrollFromBottom = Math.max(0, previous - Math.max(1, this.#pageSize - 1));
        } else if (data === "\x1b[H" || data === "g") {
            this.#scrollFromBottom = Number.MAX_SAFE_INTEGER;
        } else if (data === "\x1b[F" || data === "G") {
            this.#scrollFromBottom = 0;
        }
        if (this.#scrollFromBottom !== previous) this.#onRequestRender();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const height = Math.max(6, this.#height());
        const bodyHeight = Math.max(1, height - 5);
        this.#pageSize = bodyHeight;
        const outputLines = this.#outputLines(safeWidth);
        const maximumScroll = Math.max(0, outputLines.length - bodyHeight);
        this.#scrollFromBottom = Math.min(this.#scrollFromBottom, maximumScroll);
        const start = Math.max(0, outputLines.length - bodyHeight - this.#scrollFromBottom);
        const visible = outputLines.slice(start, start + bodyHeight);
        while (visible.length < bodyHeight) visible.push("");
        const end = Math.min(outputLines.length, start + bodyHeight);
        const status = this.#status();
        const footer = `${DIM}${start + 1}–${Math.max(start + 1, end)} of ${outputLines.length} · PgUp/PgDn scroll · End follow · ${this.#snapshot?.status === "running" ? "x stop · " : ""}Esc close${RESET}`;

        return [
            `${this.#theme.brand}${BOLD}Background terminal${NOT_BOLD_OR_DIM}${this.#theme.primary}  ${status}`,
            `${DIM}Command:${RESET}${this.#theme.primary} ${sanitizeTerminalText(this.#command).replaceAll("\n", " ")}`,
            `${DIM}Directory:${RESET}${this.#theme.primary} ${sanitizeTerminalText(this.#cwd)}`,
            `${DIM}${"─".repeat(safeWidth)}${RESET}`,
            ...visible,
            footer,
        ].map((line) => this.#surfaceLine(line, safeWidth));
    }

    #outputLines(width: number): string[] {
        if (this.#error !== undefined) return [`Error: ${sanitizeTerminalText(this.#error)}`];
        const snapshot = this.#snapshot;
        if (snapshot === undefined) return ["Waiting for output…"];
        const output = [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n");
        if (output.length === 0) {
            return [snapshot.status === "running" ? "Waiting for output…" : "(no output)"];
        }
        return sanitizeTerminalText(output)
            .replaceAll("\t", "    ")
            .replace(/\n$/u, "")
            .split("\n")
            .flatMap((line) => {
                const wrapped = wrapTextWithAnsi(line, width);
                return wrapped.length === 0 ? [""] : wrapped;
            });
    }

    #status(): string {
        if (this.#stopping) return `${this.#theme.warning}Stopping${RESET}`;
        const snapshot = this.#snapshot;
        if (snapshot === undefined) return `${this.#theme.warning}Loading${RESET}`;
        if (snapshot.status === "running") return `${this.#theme.warning}Running${RESET}`;
        if (snapshot.status === "killed") return `${this.#theme.error}Stopped${RESET}`;
        if (snapshot.exitCode === 0) return `${this.#theme.success}Completed · exit 0${RESET}`;
        return `${this.#theme.error}Failed · exit ${snapshot.exitCode ?? "unknown"}${RESET}`;
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
