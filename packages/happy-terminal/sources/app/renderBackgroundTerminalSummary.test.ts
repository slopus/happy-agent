import { describe, expect, it } from "vitest";

import { renderBackgroundTerminalSummary } from "./renderBackgroundTerminalSummary.js";

describe("renderBackgroundTerminalSummary", () => {
    it("matches Codex grammar and truncates to the terminal width", () => {
        expect(renderBackgroundTerminalSummary(0, 80)).toBeUndefined();
        expect(renderBackgroundTerminalSummary(1, 80)).toContain(
            "1 background terminal running · /ps to view · /stop to close",
        );
        expect(renderBackgroundTerminalSummary(2, 80)).toContain(
            "2 background terminals running · /ps to view · /stop to close",
        );
        expect(stripAnsi(renderBackgroundTerminalSummary(2, 24) ?? "").length).toBeLessThanOrEqual(
            24,
        );
    });
});

function stripAnsi(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\u001b") {
            result += value[index];
            continue;
        }
        while (index < value.length && value[index] !== "m") index += 1;
    }
    return result;
}
