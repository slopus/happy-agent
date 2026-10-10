import {
    createGhosttyTerminal,
    type GhosttyRow,
    type GhosttyTerminal,
} from "@slopus/ghostty-wasm/node";

import type { GhosttySnapshot, GhosttyTerminalLike } from "../GhosttyRemoteTerminal.js";

/** A screen with its visible text joined, so a test can compare two emulators at a glance. */
export interface GhosttyTestSnapshot extends GhosttySnapshot {
    text: string;
}

/** A real Ghostty emulator for protocol tests: one side of a canonical/replica pair. */
export class GhosttyTestTerminal implements GhosttyTerminalLike {
    #closed = false;
    readonly #terminal: GhosttyTerminal;

    private constructor(terminal: GhosttyTerminal) {
        this.#terminal = terminal;
    }

    static async create(cols: number, rows: number): Promise<GhosttyTestTerminal> {
        return new GhosttyTestTerminal(
            await createGhosttyTerminal({ colorScheme: "dark", cols, maxScrollback: 10_000, rows }),
        );
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#terminal.dispose();
    }

    onPtyWrite(handler: (data: string) => void): () => void {
        return this.#terminal.onPtyWrite((data) => handler(Buffer.from(data).toString("utf8")));
    }

    resize(cols: number, rows: number): void {
        this.#terminal.resize(cols, rows);
    }

    snapshot(): Promise<GhosttyTestSnapshot> {
        const current = this.#terminal.snapshot();
        const rows = current.rows.map(rowText);
        return Promise.resolve({
            cells: current.rows.flatMap((row, y) =>
                row.cells.map((cell) => ({
                    background: cell.style.background,
                    blink: cell.style.blink,
                    bold: cell.style.bold,
                    dim: cell.style.dim,
                    foreground: cell.style.foreground,
                    hyperlink: cell.hyperlink,
                    invisible: cell.style.invisible,
                    inverse: cell.style.inverse,
                    italic: cell.style.italic,
                    overline: cell.style.overline,
                    strikethrough: cell.style.strikethrough,
                    text: cell.text,
                    underline: cell.style.underline,
                    underlineColor: cell.style.underlineColor,
                    width: cell.width,
                    x: cell.x,
                    y,
                })),
            ),
            cursor: {
                visible: current.cursor?.visible ?? false,
                x: current.cursor?.x ?? 0,
                y: current.cursor?.y ?? 0,
            },
            rows,
            scroll: {
                offset: current.startRow,
                totalRows: current.totalRows,
                visibleRows: current.visibleRows,
            },
            text: rows.join("\n").trimEnd(),
            title: current.title,
            wrappedRows: current.rows.map((row) => row.wrapped),
        });
    }

    writeBytes(data: Uint8Array): void {
        if (this.#closed) throw new Error("The Ghostty terminal is closed.");
        this.#terminal.write(data);
    }
}

function rowText(row: GhosttyRow): string {
    let result = "";
    let column = 0;
    for (const cell of row.cells) {
        result += " ".repeat(Math.max(0, cell.x - column));
        result += cell.text;
        column = cell.x + cell.width;
    }
    return result.trimEnd();
}
