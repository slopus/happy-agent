import { describe, expect, it } from "vitest";

import { formatStartupStatusUsageRows } from "./formatStartupStatusUsageRows.js";

describe("formatStartupStatusUsageRows", () => {
    it("renders independent five-hour and weekly windows together", () => {
        expect(
            formatStartupStatusUsageRows(
                {
                    fiveHour: {
                        capturedAt: 1_000,
                        percentLeft: 68,
                        resetsIn: "2h 14m",
                    },
                    weekly: {
                        capturedAt: 1_000,
                        percentLeft: 84,
                        resetsIn: "4d 6h",
                    },
                },
                72,
            ),
        ).toEqual(["Usage: 5h 68% left · week 84% left", "Resets: 5h in 2h 14m · week in 4d 6h"]);
    });

    it("renders only the five-hour window when weekly data is unavailable", () => {
        expect(formatStartupStatusUsageRows({ fiveHour: { percentLeft: 41 } }, 72)).toEqual([
            "Usage: 5h 41% left",
        ]);
    });

    it("renders only the weekly window when five-hour data is unavailable", () => {
        expect(
            formatStartupStatusUsageRows({ weekly: { percentLeft: 84, resetsIn: "4d 6h" } }, 72),
        ).toEqual(["Usage: week 84% left", "Resets: week in 4d 6h"]);
    });

    it("omits unavailable or empty usage data", () => {
        expect(formatStartupStatusUsageRows(undefined, 72)).toEqual([]);
        expect(formatStartupStatusUsageRows({}, 72)).toEqual([]);
    });

    it("prioritizes both remaining percentages at nineteen columns", () => {
        expect(
            formatStartupStatusUsageRows(
                {
                    fiveHour: { percentLeft: 68, resetsIn: "2h 14m" },
                    weekly: { percentLeft: 84, resetsIn: "4d 6h" },
                },
                15,
            ),
        ).toEqual(["5h 68% left", "week 84% left"]);
    });

    it("renders fractional remaining percentages cleanly at wide and narrow widths", () => {
        const usage = { fiveHour: { percentLeft: 0.2 } };

        expect(formatStartupStatusUsageRows(usage, 72)).toEqual(["Usage: 5h 0.2% left"]);
        expect(formatStartupStatusUsageRows(usage, 15)).toEqual(["5h 0.2% left"]);
    });
});
