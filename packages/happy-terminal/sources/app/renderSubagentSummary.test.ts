import { describe, expect, it } from "vitest";

import { renderSubagentSummary } from "./renderSubagentSummary.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderSubagentSummary", () => {
    it("uses compact grammar and truncates to the terminal width", () => {
        expect(
            renderSubagentSummary({ count: 0, elapsedMs: 0, totalTokens: 0, width: 80 }),
        ).toBeUndefined();
        expect(
            stripAnsi(
                renderSubagentSummary({
                    count: 1,
                    elapsedMs: 65_000,
                    totalTokens: 1_250,
                    width: 80,
                }) ?? "",
            ).trimEnd(),
        ).toBe("  1 agent running · /agents to view · 1m 5s · 1.3k context tokens");
        expect(
            stripAnsi(
                renderSubagentSummary({
                    count: 2,
                    elapsedMs: 7_000,
                    totalTokens: 999,
                    width: 20,
                }) ?? "",
            ).length,
        ).toBeLessThanOrEqual(20);
    });
});
