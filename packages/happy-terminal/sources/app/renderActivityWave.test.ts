import { describe, expect, it } from "vitest";

import { renderActivityWave } from "./renderActivityWave.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderActivityWave", () => {
    it("renders readable text with a moving grayscale highlight", () => {
        const firstFrame = renderActivityWave("Working", 0, { isLight: false });
        const secondFrame = renderActivityWave("Working", 1, { isLight: false });

        expect(stripAnsi(firstFrame)).toBe("Working");
        expect(stripAnsi(secondFrame)).toBe("Working");
        expect(firstFrame).not.toBe(secondFrame);
        expect(firstFrame).toContain("\x1b[38;5;255m");
        expect(firstFrame).toContain("\x1b[38;5;244m");
    });

    it("uses dark foregrounds on a light terminal background", () => {
        const frame = renderActivityWave("Working", 0, { isLight: true });

        expect(stripAnsi(frame)).toBe("Working");
        expect(frame).toContain("\x1b[38;5;232m");
        expect(frame).toContain("\x1b[38;5;240m");
        expect(frame).not.toContain("\x1b[38;5;255m");
    });
});
