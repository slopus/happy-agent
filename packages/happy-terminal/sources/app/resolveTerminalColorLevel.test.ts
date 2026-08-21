import { describe, expect, it } from "vitest";

import { resolveTerminalColorLevel } from "./resolveTerminalColorLevel.js";

describe("resolveTerminalColorLevel", () => {
    it("uses true color when COLORTERM advertises it", () => {
        expect(resolveTerminalColorLevel({ COLORTERM: "truecolor" })).toBe("truecolor");
        expect(resolveTerminalColorLevel({ COLORTERM: "24BIT" })).toBe("truecolor");
    });

    it("uses true color when TERM advertises a direct color mode", () => {
        expect(resolveTerminalColorLevel({ TERM: "xterm-direct" })).toBe("truecolor");
    });

    it("falls back to the ANSI 256 palette", () => {
        expect(resolveTerminalColorLevel({ TERM: "xterm-256color" })).toBe("ansi256");
    });
});
