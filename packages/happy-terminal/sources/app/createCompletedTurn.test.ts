import { describe, expect, it } from "vitest";

import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";
import { compactCompletedTurnEntries } from "./compactCompletedTurnEntries.js";
import { createCompletedTurn } from "./createCompletedTurn.js";

describe("createCompletedTurn", () => {
    it("keeps user input and the final answer while summarizing hidden work", () => {
        const entries: AppTranscriptEntry[] = [
            { id: "intermediate", role: "assistant", text: "I will edit the file." },
            {
                fileDiffs: [
                    {
                        hunks: [
                            {
                                lines: [
                                    { kind: "delete", text: "before" },
                                    { kind: "add", text: "after" },
                                ],
                                newStart: 1,
                                oldStart: 1,
                            },
                        ],
                        kind: "update",
                        path: "note.txt",
                    },
                ],
                id: "tool",
                role: "tool",
                text: "note.txt",
            },
            { id: "steering", role: "user", text: "Keep the change small." },
            { id: "final", role: "assistant", text: "Updated the note." },
        ];

        const completed = createCompletedTurn(entries, 2_500);
        expect(completed).toEqual({
            entry: entries[3],
            turn: {
                hiddenEntryIds: ["intermediate", "tool"],
                stats: {
                    additions: 1,
                    deletions: 1,
                    elapsedMs: 2_500,
                    fileCount: 1,
                    toolCount: 1,
                },
            },
        });
        if (completed === undefined) throw new Error("Expected a completed turn.");
        completed.entry.completedTurn = completed.turn;
        expect(compactCompletedTurnEntries(entries).map((entry) => entry.id)).toEqual([
            "steering",
            "final",
        ]);
    });

    it("does not compact a completed run without a final assistant message", () => {
        expect(
            createCompletedTurn([{ id: "tool", role: "tool", text: "Ran a command" }], 100),
        ).toBeUndefined();
    });
});
