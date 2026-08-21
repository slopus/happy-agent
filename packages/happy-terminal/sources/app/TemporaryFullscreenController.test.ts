import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { TemporaryFullscreenController } from "./TemporaryFullscreenController.js";

describe("TemporaryFullscreenController", () => {
    it("renders on the alternate screen and restores the preserved main screen", () => {
        const tui = fakeTui();
        const controller = new TemporaryFullscreenController(tui);

        controller.open();

        expect(tui.terminal.write).toHaveBeenCalledWith("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");

        controller.render(["Fullscreen", ""], 80, 20);
        expect(tui.terminal.write).toHaveBeenLastCalledWith(
            "\x1b[?2026h\x1b[HFullscreen\r\n\x1b[?2026l\x1b[?25l",
        );

        controller.close();
        expect(tui.terminal.write).toHaveBeenLastCalledWith("\x1b[?1049l");
        expect(tui.requestRender).toHaveBeenCalledWith(false);
    });

    it("requests a full normal-screen redraw only after a terminal resize", () => {
        const tui = fakeTui();
        const controller = new TemporaryFullscreenController(tui);

        controller.open();
        controller.render(["Resized"], 60, 15);
        controller.close();

        expect(tui.requestRender).toHaveBeenCalledWith(true);
    });
});

function fakeTui(): TUI {
    return {
        requestRender: vi.fn(),
        terminal: { columns: 80, rows: 20, write: vi.fn() },
    } as unknown as TUI;
}
