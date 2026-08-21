import { describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

describe("widening a scrolled session until it fits", () => {
    // Real-emulator regression: disposal traps after this resize and incremental-render sequence.
    it.fails("reanchors the reflowed frame before the next incremental composer render", async () => {
        const history = [
            "WIDEN_HISTORY_BEGIN",
            ...Array.from(
                { length: 7 },
                (_, index) =>
                    `WIDEN_HISTORY_${String(index).padStart(2, "0")} has enough stable text to wrap more than once in the narrow terminal viewport`,
            ),
            "WIDEN_HISTORY_MIDDLE",
            "WIDEN_HISTORY_END",
        ].join("\n");
        const gym = await createGym({
            cols: 52,
            inference: [
                { content: [{ text: history, type: "text" }] },
                { content: [{ text: "WIDEN_FOLLOW_UP_OK", type: "text" }] },
            ],
            rows: 14,
        });

        try {
            submit(gym, "Create narrow history before widening the terminal.");
            const narrow = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("WIDEN_HISTORY_END") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    snapshot.scroll.atBottom,
                "overflowing narrow history at the bottom",
                30_000,
            );
            expect(narrow.scroll.totalRows).toBeGreaterThan(narrow.scroll.visibleRows);

            gym.terminal.scrollToTop();
            gym.terminal.scrollBy(14);
            const reading = await gym.terminal.snapshot();
            expect(reading.scroll.atTop).toBe(false);
            expect(reading.scroll.atBottom).toBe(false);
            expect(reading.text).toContain("WIDEN_HISTORY_");

            gym.terminal.resize(120, 40);
            gym.terminal.type("x");
            const widened = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.rows.length === 40 &&
                    snapshot.scroll.visibleRows === 40 &&
                    snapshot.text.includes("WIDEN_HISTORY_BEGIN") &&
                    snapshot.text.includes("WIDEN_HISTORY_END") &&
                    snapshot.rows.some((row) => row.trim() === "› x"),
                "the widened session after an incremental composer render",
                30_000,
            );
            expect(
                widened.scroll.atBottom ||
                    widened.scroll.offset + widened.scroll.visibleRows === widened.scroll.totalRows,
            ).toBe(true);
            expect(widened.scroll.offset + widened.scroll.visibleRows).toBe(
                widened.scroll.totalRows,
            );
            expect(widened.text).not.toContain("�");

            const historyEndRow = rowContaining(widened.rows, "WIDEN_HISTORY_END");
            const composerRow = rowContaining(widened.rows, "› x");
            expect(historyEndRow).toBeLessThan(composerRow);
            expect(
                maximumBlankRun(widened.rows.slice(historyEndRow, composerRow)),
            ).toBeLessThanOrEqual(2);

            const transcript = widened.text;
            expect(countOccurrences(transcript, "WIDEN_HISTORY_BEGIN")).toBe(1);
            expect(countOccurrences(transcript, "WIDEN_HISTORY_MIDDLE")).toBe(1);
            expect(countOccurrences(transcript, "WIDEN_HISTORY_END")).toBe(1);
            expect(transcript.split("\n").filter((row) => row.trim() === "› x")).toHaveLength(1);
            expect(countOccurrences(transcript, "gym off · /workspace")).toBe(1);

            gym.terminal.press("backspace");
            await gym.terminal.waitForText("Ask Happy Terminal to do anything");
            submit(gym, "Confirm the widened session remains usable.");
            const followUp = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("WIDEN_FOLLOW_UP_OK") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    snapshot.scroll.atBottom,
                "a follow-up after widening the scrolled session",
                30_000,
            );
            expect(followUp.scroll.offset + followUp.scroll.visibleRows).toBe(
                followUp.scroll.totalRows,
            );
            expect(followUp.text).not.toContain("�");
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
