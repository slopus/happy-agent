import { CURSOR_MARKER, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const EXIT_ALTERNATE_SCREEN = "\x1b[?1049l";

export class TemporaryFullscreenController {
    readonly #tui: TUI;

    #active = false;
    #entryColumns = 0;
    #entryRows = 0;
    #resized = false;

    constructor(tui: TUI) {
        this.#tui = tui;
    }

    open(restoreWithFullRedraw = false): void {
        if (this.#active) return;
        this.#active = true;
        this.#entryColumns = this.#tui.terminal.columns;
        this.#entryRows = this.#tui.terminal.rows;
        this.#resized = restoreWithFullRedraw;
        this.#tui.terminal.write(ENTER_ALTERNATE_SCREEN);
    }

    render(lines: readonly string[], width: number, height: number): void {
        if (!this.#active) return;
        if (width !== this.#entryColumns || height !== this.#entryRows) this.#resized = true;

        let cursor: { column: number; row: number } | undefined;
        const rendered = lines.map((line, row) => {
            const markerIndex = line.indexOf(CURSOR_MARKER);
            if (markerIndex < 0) return line;
            cursor = { column: visibleWidth(line.slice(0, markerIndex)), row };
            return line.replaceAll(CURSOR_MARKER, "");
        });
        const cursorControl =
            cursor === undefined
                ? "\x1b[?25l"
                : `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
        this.#tui.terminal.write(
            `\x1b[?2026h\x1b[H${rendered.join("\r\n")}\x1b[?2026l${cursorControl}`,
        );
    }

    close(): void {
        if (!this.#active) return;
        this.#tui.terminal.write(EXIT_ALTERNATE_SCREEN);
        this.#active = false;
        this.#tui.requestRender(this.#resized);
    }

    dispose(): void {
        if (!this.#active) return;
        this.#tui.terminal.write(EXIT_ALTERNATE_SCREEN);
        this.#active = false;
    }
}
