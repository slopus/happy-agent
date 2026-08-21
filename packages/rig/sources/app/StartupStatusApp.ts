import { truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

import type { AgentCatalogEntry } from "../client/index.js";
import { createSelectionPanel } from "./createSelectionPanel.js";
import { createSessionPicker, fitSessionPickerToViewport } from "./createSessionPicker.js";
import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { renderActivityWave } from "./renderActivityWave.js";
import { renderRigBanner } from "./renderRigBanner.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const ACTIVITY_ANIMATION_MS = 120;
/** Rows the banner, status line, and surrounding blanks occupy above a panel. */
const STARTUP_CHROME_ROWS = 10;

export interface StartupStatusAppOptions {
    cwd: string;
    now?: () => number;
    rows?: () => number;
    tui: TUI;
    version: string;
    theme?: TerminalTheme;
}

export class StartupStatusApp implements Component, Focusable {
    readonly #now: () => number;
    readonly #rows: () => number;
    readonly #tui: TUI;
    readonly #version: string;
    readonly #theme: TerminalTheme;

    focused = false;
    #activityAnimationFrame = 0;
    #selectionPanel: Component | undefined;
    #startedAtMs: number;
    #status = "Preparing local daemon.";
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(options: StartupStatusAppOptions) {
        this.#now = options.now ?? Date.now;
        this.#rows = options.rows ?? (() => process.stdout.rows ?? 24);
        this.#startedAtMs = this.#now();
        this.#tui = options.tui;
        this.#version = options.version;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines = [
            "",
            ...renderRigBanner({
                brand: this.#theme.brand,
                secondary: this.#theme.secondary,
                version: this.#version,
                width: safeWidth,
            }),
            "",
            this.#renderStatusLine(safeWidth),
            "",
        ];
        if (this.#selectionPanel !== undefined) {
            fitSessionPickerToViewport(
                this.#selectionPanel,
                safeWidth,
                Math.max(1, this.#rows() - STARTUP_CHROME_ROWS),
            );
            lines.push(...this.#selectionPanel.render(safeWidth));
        }
        return lines;
    }

    /**
     * Lets the user pick a saved agent on the same startup screen the daemon status uses, so
     * `rig resume` never drops out of the TUI into a numbered prompt. Resolves undefined when the
     * user dismisses the picker.
     */
    selectSession(options: {
        agents: readonly AgentCatalogEntry[];
        confirmVerb: string;
        showDirectory: boolean;
        subtitle: string;
        title: string;
    }): Promise<string | undefined> {
        this.setStatus("Waiting for an agent choice.");
        return new Promise((resolve) => {
            const finish = (sessionId: string | undefined) => {
                this.#selectionPanel = undefined;
                this.#tui.requestRender();
                resolve(sessionId);
            };
            this.#selectionPanel = createSessionPicker({
                confirmVerb: options.confirmVerb,
                now: this.#now,
                onCancel: () => finish(undefined),
                onSelect: (entry) => finish(entry.agent.id),
                agents: options.agents,
                showDirectory: options.showDirectory,
                subtitle: options.subtitle,
                theme: this.#theme,
                title: options.title,
            });
            this.#tui.requestRender();
        });
    }

    handleInput(data: string): void {
        this.#selectionPanel?.handleInput?.(data === "\x03" ? "\x1b" : data);
        this.#tui.requestRender();
    }

    setStatus(status: string): void {
        this.#status = status;
        this.#tui.requestRender();
    }

    start(): void {
        this.#tui.addChild(this);
        this.#tui.setFocus(this);
        this.#timer = setInterval(() => {
            this.#activityAnimationFrame = (this.#activityAnimationFrame + 1) % 12;
            this.#tui.requestRender();
        }, ACTIVITY_ANIMATION_MS);
        this.#timer.unref?.();
        this.#tui.start();
        this.#tui.requestRender();
    }

    stop(): void {
        if (this.#timer !== undefined) {
            clearInterval(this.#timer);
            this.#timer = undefined;
        }
        this.#tui.removeChild(this);
        this.#tui.requestRender();
    }

    #renderStatusLine(width: number): string {
        const elapsed = formatActivityElapsedTime(this.#now() - this.#startedAtMs);
        const elapsedSuffix =
            elapsed === undefined ? "" : ` ${DIM}${this.#theme.secondary}(${elapsed})${RESET}`;
        return this.#fitLine(
            `${this.#theme.brand}•${RESET} ${renderActivityWave(this.#status, this.#activityAnimationFrame, this.#theme)}${elapsedSuffix}`,
            width,
        );
    }

    #fitLine(line: string, width: number): string {
        return truncateToWidth(line, width, "", true);
    }
}
