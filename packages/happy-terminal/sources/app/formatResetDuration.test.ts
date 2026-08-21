import { describe, expect, it } from "vitest";

import { formatResetDuration } from "./formatResetDuration.js";

describe("formatResetDuration", () => {
    it("formats short remaining time with seconds for live countdowns", () => {
        expect(formatResetDuration(0)).toBe("now");
        expect(formatResetDuration(-1)).toBe("now");
        expect(formatResetDuration(1)).toBe("1s");
        expect(formatResetDuration(45_100)).toBe("46s");
        expect(formatResetDuration(60_000)).toBe("1m 0s");
        expect(formatResetDuration(65_001)).toBe("1m 6s");
        expect(formatResetDuration(11 * 60_000)).toBe("11m 0s");
    });

    it("keeps multi-hour and multi-day quota windows coarse", () => {
        expect(formatResetDuration(2 * 3_600_000)).toBe("2h");
        expect(formatResetDuration((2 * 60 + 14) * 60_000)).toBe("2h 14m");
        expect(formatResetDuration((6 * 24 + 2) * 3_600_000)).toBe("6d 2h");
        expect(formatResetDuration(4 * 86_400_000)).toBe("4d");
    });
});
