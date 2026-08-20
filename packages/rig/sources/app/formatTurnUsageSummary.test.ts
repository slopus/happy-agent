import { describe, expect, it } from "vitest";

import { formatTurnUsageSummary } from "./formatTurnUsageSummary.js";

describe("formatTurnUsageSummary", () => {
    it("summarizes generated tokens and the weighted cache hit rate", () => {
        expect(
            formatTurnUsageSummary({
                cacheRead: 900,
                cacheWrite: 100,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                input: 1_000,
                output: 3_120,
                totalTokens: 4_120,
            }),
        ).toBe("3.1k generated · 90% cache hit");
    });

    it("reports no cache hits when nothing cache-eligible was sent", () => {
        expect(
            formatTurnUsageSummary({
                cacheRead: 0,
                cacheWrite: 0,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                input: 0,
                output: 42,
                totalTokens: 42,
            }),
        ).toBe("42 generated · 0% cache hit");
    });
});
