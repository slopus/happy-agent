import { describe, expect, it } from "vitest";

import { renderServerToolCallSummary } from "./renderServerToolCallSummary.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderServerToolCallSummary", () => {
    it("keeps every provider-run call on one truncated row", () => {
        expect(renderServerToolCallSummary([], 80)).toBeUndefined();
        expect(
            stripAnsi(
                renderServerToolCallSummary(['Searching X for "Claude Code"'], 80) ?? "",
            ).trimEnd(),
        ).toBe('  Searching X for "Claude Code"');
        expect(
            stripAnsi(
                renderServerToolCallSummary(
                    ['Searching X for "Claude Code"', "Searching the web", "Searching X"],
                    80,
                ) ?? "",
            ).trimEnd(),
        ).toBe('  Searching X for "Claude Code" · 2 more running');
        expect(
            stripAnsi(renderServerToolCallSummary(['Searching X for "Claude Code"'], 20) ?? "")
                .length,
        ).toBeLessThanOrEqual(20);
    });
});
