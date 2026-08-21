import { describe, expect, it } from "vitest";

import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";

describe("formatActivityElapsedTime", () => {
    it("formats elapsed time as seconds, minutes, and hours", () => {
        expect(formatActivityElapsedTime(0)).toBe("0s");
        expect(formatActivityElapsedTime(7_900)).toBe("7s");
        expect(formatActivityElapsedTime(65_000)).toBe("1m 5s");
        expect(formatActivityElapsedTime(3_723_000)).toBe("1h 2m 3s");
    });
});
