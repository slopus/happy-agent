import { describe, expect, it } from "vitest";

import { diffInstructionLines } from "../../sources/stablePrompt/impl/diffInstructionLines.js";
import {
    MAX_INSTRUCTIONS_CHANGE_CHARACTERS,
    formatInstructionsChange,
} from "../../sources/stablePrompt/impl/formatInstructionsChange.js";

describe("diffInstructionLines", () => {
    it("finds nothing between equal texts and between texts that differ only in blank lines", () => {
        expect(diffInstructionLines("a\nb", "a\nb")).toEqual([]);
        expect(diffInstructionLines("a\n\nb\n", "a\nb\n\n\n")).toEqual([]);
    });

    it("pairs each run of removed lines with the lines that replaced it", () => {
        expect(diffInstructionLines("a\nb\nc\nd\ne", "a\nB\nc\nD1\nD2\ne")).toEqual([
            { removed: ["b"], added: ["B"] },
            { removed: ["d"], added: ["D1", "D2"] },
        ]);
    });

    it("reports additions and removals that replace nothing", () => {
        expect(diffInstructionLines("a\nc", "a\nb\nc")).toEqual([{ removed: [], added: ["b"] }]);
        expect(diffInstructionLines("a\nb\nc", "a\nc")).toEqual([{ removed: ["b"], added: [] }]);
        expect(diffInstructionLines("", "a")).toEqual([{ removed: [], added: ["a"] }]);
    });

    it("keeps a moved section readable as one removal and one addition", () => {
        expect(diffInstructionLines("a\nb\nc", "b\nc\na")).toEqual([
            { removed: ["a"], added: [] },
            { removed: [], added: ["a"] },
        ]);
    });

    it("reports a region too large to align as one replacement", () => {
        const old = Array.from({ length: 2100 }, (_, index) => `old ${String(index)}`);
        const now = Array.from({ length: 2100 }, (_, index) => `new ${String(index)}`);
        const changes = diffInstructionLines(
            ["same", ...old, "end"].join("\n"),
            ["same", ...now, "end"].join("\n"),
        );
        expect(changes).toEqual([{ removed: old, added: now }]);
    });
});

describe("formatInstructionsChange", () => {
    it("quotes what stopped applying and what applies now", () => {
        const text = formatInstructionsChange([
            { removed: ["Mode: auto."], added: ["Mode: read only."] },
            { removed: [], added: ["A new rule."] },
            { removed: ["An old rule."], added: [] },
        ]);
        expect(text.split("\n\n").slice(1)).toEqual([
            "<removed>\nMode: auto.\n</removed>\n<added>\nMode: read only.\n</added>",
            "<added>\nA new rule.\n</added>",
            "<removed>\nAn old rule.\n</removed>",
        ]);
        expect(text).toMatch(/^# Instructions changed\nYour instructions changed/u);
    });

    it("stays within its bound and says so when more changed than fits", () => {
        const line = "x".repeat(1000);
        const text = formatInstructionsChange(
            Array.from({ length: 100 }, () => ({ removed: [line], added: [line] })),
        );
        expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHANGE_CHARACTERS + 200);
        expect(text).toMatch(/\[More of the instructions changed than fits in this notice\./u);
    });
});
