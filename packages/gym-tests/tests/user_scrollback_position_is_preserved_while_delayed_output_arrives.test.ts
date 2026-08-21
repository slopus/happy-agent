import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("user scrollback position is preserved while delayed output arrives", () => {
    it("keeps historical rows visible until the user returns to live output", async () => {
        const initialHistory = [
            "HISTORICAL_RESPONSE_BEGIN",
            ...Array.from(
                { length: 140 },
                (_, index) => `- Historical line ${String(index).padStart(3, "0")}`,
            ),
            "HISTORICAL_RESPONSE_END",
        ].join("\n");
        const delayedResponse = [
            "DELAYED_OUTPUT_BEGIN",
            ...Array.from(
                { length: 90 },
                (_, index) => `- Delayed line ${String(index).padStart(3, "0")}`,
            ),
            "DELAYED_OUTPUT_END",
        ].join("\n");
        const gym = await createGym({
            cols: 68,
            inference: [
                { content: [{ text: initialHistory, type: "text" }] },
                {
                    content: [{ text: delayedResponse, type: "text" }],
                    delayMs: 1_500,
                },
            ],
            rows: 16,
        });
        running.add(gym);
        const startupScroll = (await gym.terminal.snapshot()).scroll;

        gym.terminal.type("Create enough history for me to read.");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("HISTORICAL_RESPONSE_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "initial history and idle composer at the bottom",
            30_000,
        );

        gym.terminal.type("Add another long response after a delay.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Working", 30_000);
        gym.terminal.scrollToTop();
        const readingHistory = await gym.terminal.snapshot();

        expect(readingHistory.scroll.atTop).toBe(true);
        expect(readingHistory.scroll.atBottom).toBe(false);
        expect(readingHistory.scroll.offset).toBe(0);
        expect(readingHistory.scroll.bottomDepartureCount).toBe(
            startupScroll.bottomDepartureCount + 1,
        );
        expect(readingHistory.scroll.topArrivalCount).toBe(startupScroll.topArrivalCount + 1);
        const historicalRows = readingHistory.rows;
        const historicalText = readingHistory.text;
        const totalRowsBeforeOutput = readingHistory.scroll.totalRows;

        const outputWhileReading = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.scroll.totalRows >= totalRowsBeforeOutput + 30 &&
                snapshot.scroll.atTop &&
                !snapshot.scroll.atBottom,
            "delayed output to extend scrollback without moving the historical viewport",
            30_000,
        );
        expect(outputWhileReading.scroll.offset).toBe(0);
        expect(outputWhileReading.rows).toEqual(historicalRows);
        expect(outputWhileReading.text).toBe(historicalText);
        expect(outputWhileReading.scroll.bottomDepartureCount).toBe(
            readingHistory.scroll.bottomDepartureCount,
        );
        expect(outputWhileReading.scroll.topArrivalCount).toBe(
            readingHistory.scroll.topArrivalCount,
        );

        gym.terminal.scrollToBottom();
        const liveOutput = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("DELAYED_OUTPUT_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "delayed response and idle composer after returning to the bottom",
            30_000,
        );
        expect(liveOutput.rows).toHaveLength(16);
        expect(liveOutput.scroll.visibleRows).toBe(16);
        expect(liveOutput.scroll.offset + liveOutput.scroll.visibleRows).toBe(
            liveOutput.scroll.totalRows,
        );
        expect(liveOutput.scroll.bottomDepartureCount).toBe(
            readingHistory.scroll.bottomDepartureCount,
        );
        expect(liveOutput.scroll.topArrivalCount).toBe(readingHistory.scroll.topArrivalCount);
        expect(liveOutput.text).toContain("gym off · /workspace");
        expect(liveOutput.text).not.toContain("�");
        expect(liveOutput.cursor.x).toBeLessThan(68);
        expect(liveOutput.cursor.y).toBeLessThan(16);
    }, 120_000);
});
