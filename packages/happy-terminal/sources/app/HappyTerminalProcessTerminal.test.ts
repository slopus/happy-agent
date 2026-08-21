import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HappyTerminalProcessTerminal } from "./HappyTerminalProcessTerminal.js";

describe("HappyTerminalProcessTerminal", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forwards Pi's authoritative redraw output unchanged", () => {
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const terminal = new HappyTerminalProcessTerminal();

        terminal.write("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe\x1b[?2026l");

        expect(write).toHaveBeenCalledWith("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe\x1b[?2026l");
    });

    it("lets Pi rebuild the complete frame after a resize", async () => {
        const terminal = new RecordingHappyTerminalProcessTerminal(80, 12);
        const tui = new TUI(terminal, false);
        const transcript = ["› Keep this user message", "• Keep this agent message"];
        tui.addChild({
            invalidate() {},
            render: () => [
                ...transcript,
                "",
                "◦ Working",
                "",
                "› Ask Happy Terminal to do anything",
            ],
        });
        tui.start();
        await renderCycle();
        terminal.output.length = 0;

        terminal.columns = 48;
        terminal.emitResize();
        await renderCycle();

        const output = terminal.output.join("");
        expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
        expect(output).toContain("Keep this user message");
        expect(output).toContain("Keep this agent message");
        expect(output).toContain("Working");
        tui.stop();
    });
});

class RecordingHappyTerminalProcessTerminal
    extends HappyTerminalProcessTerminal
    implements Terminal
{
    readonly output: string[] = [];
    #columns: number;
    #rows: number;
    #onResize: (() => void) | undefined;

    constructor(columns: number, rows: number) {
        super();
        this.#columns = columns;
        this.#rows = rows;
    }

    override get columns(): number {
        return this.#columns;
    }
    override set columns(columns: number) {
        this.#columns = columns;
    }
    override get kittyProtocolActive(): boolean {
        return false;
    }
    override get rows(): number {
        return this.#rows;
    }
    override set rows(rows: number) {
        this.#rows = rows;
    }

    override start(_onInput?: (data: string) => void, onResize?: () => void): void {
        this.#onResize = onResize;
    }
    override stop(): void {}
    override async drainInput(): Promise<void> {}
    override write(data: string): void {
        this.output.push(data);
    }
    override moveBy(): void {}
    override hideCursor(): void {}
    override showCursor(): void {}
    override clearLine(): void {}
    override clearFromCursor(): void {}
    override clearScreen(): void {}
    override setTitle(): void {}
    override setProgress(): void {}

    emitResize(): void {
        this.#onResize?.();
    }
}

async function renderCycle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
