import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderCompletedTurnStats } from "./renderCompletedTurnStats.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderCompletedTurnStats", () => {
    it("renders readable stats without exceeding a narrow terminal", () => {
        const rendered = renderCompletedTurnStats(
            {
                additions: 214,
                deletions: 37,
                elapsedMs: 138_000,
                fileCount: 8,
                toolCount: 12,
            },
            30,
        );

        expect(visibleWidth(rendered)).toBeLessThanOrEqual(30);
        expect(stripAnsi(rendered)).toBe("• Worked for 2m 18s · 12 tools");
    });

    it("appends the turn usage summary after the work stats", () => {
        const rendered = renderCompletedTurnStats(
            {
                additions: 10,
                deletions: 4,
                elapsedMs: 12_000,
                fileCount: 2,
                toolCount: 3,
            },
            120,
            "3.1k generated · 50% cache hit",
        );

        expect(stripAnsi(rendered).trimEnd()).toBe(
            "• Worked for 12s · 3 tools · 2 files · +10 -4 · 3.1k generated · 50% cache hit",
        );
    });
});
