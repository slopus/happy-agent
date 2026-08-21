import { describe, expect, it } from "vitest";

import { stripAnsi } from "./stripAnsi.js";

describe("stripAnsi", () => {
    it("removes CSI, OSC, and application control sequences", () => {
        expect(
            stripAnsi(
                "plain\x1b[38;5;202m orange\x1b[0m \x1b]8;;https://example.com\x07linked\x1b]8;;\x1b\\ \x1b_pi:c\x07done",
            ),
        ).toBe("plain orange linked done");
    });
});
