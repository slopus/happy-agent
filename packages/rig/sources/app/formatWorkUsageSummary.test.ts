import { describe, expect, it } from "vitest";

import type { Usage } from "../protocol/index.js";
import { formatWorkUsageDetails, formatWorkUsageSummary } from "./formatWorkUsageSummary.js";

describe("formatWorkUsageSummary", () => {
    it("keeps compact status rows compact", () => {
        expect(
            formatWorkUsageSummary(usage({ input: 418_930, output: 2_138, cacheRead: 331_136 }), {
                contextTokens: 24_070,
            }),
        ).toBe("89.9k used · 79% cache hit · 24.1k context");
    });

    it("gives multiline views one labeled provider counter per line", () => {
        expect(
            formatWorkUsageDetails(
                usage({
                    input: 418_930,
                    output: 2_138,
                    cacheRead: 331_136,
                    cacheWrite: 12_345,
                }),
            ),
        ).toEqual([
            "Used: 89.9k",
            "Input: 418.9k",
            "Output: 2.1k",
            "Cache read: 331.1k",
            "Cache write: 12.3k",
            "Cache hit: 79%",
        ]);
    });

    it("clamps inconsistent provider counters instead of reporting negative fresh input", () => {
        expect(formatWorkUsageSummary(usage({ input: 100, output: 25, cacheRead: 120 }))).toBe(
            "25 used · 100% cache hit",
        );
    });
});

function usage(values: Pick<Usage, "cacheRead" | "input" | "output"> & Partial<Usage>): Usage {
    return {
        cacheRead: values.cacheRead,
        cacheWrite: values.cacheWrite ?? 0,
        cost: values.cost ?? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: values.input,
        output: values.output,
        totalTokens: values.totalTokens ?? values.input + values.output,
    };
}
