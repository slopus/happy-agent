import { describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

describe("whitespace-only assistant segments", () => {
    it("adds no blank transcript rows and leaves the composer usable", async () => {
        const gym = await createGym({
            cols: 76,
            homeFiles: {
                "Happy/Config/happy.toml": "[settings]\nshow_reasoning = true\n",
            },
            inference: [
                {
                    content: [
                        { text: "WHITESPACE_NORMAL_BEFORE", type: "text" },
                        { text: "  \n\n ", type: "text" },
                        { thinking: "\n\n", type: "thinking" },
                        { text: "WHITESPACE_NORMAL_AFTER", type: "text" },
                    ],
                    textDeltaChunkSize: 3,
                    thinkingDeltaChunkSize: 1,
                },
                { content: [{ text: "WHITESPACE_FOLLOW_UP_OK", type: "text" }] },
            ],
            rows: 24,
        });

        try {
            submit(gym, "Render only meaningful assistant segments.");
            const settled = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("WHITESPACE_NORMAL_BEFORE") &&
                    snapshot.text.includes("WHITESPACE_NORMAL_AFTER") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    snapshot.scroll.atBottom,
                "normal content around empty assistant segments",
                30_000,
            );

            expect(countOccurrences(settled.text, "WHITESPACE_NORMAL_BEFORE")).toBe(1);
            expect(countOccurrences(settled.text, "WHITESPACE_NORMAL_AFTER")).toBe(1);
            const beforeRow = rowContaining(settled.rows, "WHITESPACE_NORMAL_BEFORE");
            const afterRow = rowContaining(settled.rows, "WHITESPACE_NORMAL_AFTER");
            const composerRow = rowContaining(settled.rows, "Ask Happy Terminal to do anything");
            expect(beforeRow).toBeLessThan(afterRow);
            expect(afterRow).toBeLessThan(composerRow);
            expect(
                maximumBlankRun(settled.rows.slice(beforeRow, afterRow + 1)),
            ).toBeLessThanOrEqual(2);
            expect(maximumBlankRun(settled.rows.slice(afterRow, composerRow))).toBeLessThanOrEqual(
                2,
            );
            expect(
                settled.rows.slice(beforeRow, composerRow).filter((row) => row.trim() === "•"),
            ).toEqual([]);

            const firstTurn = await captureScrollback(gym);
            expect(countOccurrences(firstTurn, "WHITESPACE_NORMAL_BEFORE")).toBe(1);
            expect(countOccurrences(firstTurn, "WHITESPACE_NORMAL_AFTER")).toBe(1);

            submit(gym, "Confirm the composer still works.");
            const followUp = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("WHITESPACE_FOLLOW_UP_OK") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    snapshot.scroll.atBottom,
                "a follow-up after whitespace-only content",
                30_000,
            );
            expect(followUp.text).not.toContain("�");

            const finalTranscript = await captureScrollback(gym);
            expect(countOccurrences(finalTranscript, "WHITESPACE_NORMAL_BEFORE")).toBe(1);
            expect(countOccurrences(finalTranscript, "WHITESPACE_NORMAL_AFTER")).toBe(1);
            expect(countOccurrences(finalTranscript, "WHITESPACE_FOLLOW_UP_OK")).toBe(1);
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function rowContaining(rows: readonly string[], text: string): number {
    const row = rows.findIndex((candidate) => candidate.includes(text));
    expect(row).toBeGreaterThanOrEqual(0);
    return row;
}

function countOccurrences(value: string, search: string): number {
    return value.split(search).length - 1;
}

function maximumBlankRun(rows: readonly string[]): number {
    let maximum = 0;
    let current = 0;
    for (const row of rows) {
        current = row.trim().length === 0 ? current + 1 : 0;
        maximum = Math.max(maximum, current);
    }
    return maximum;
}
