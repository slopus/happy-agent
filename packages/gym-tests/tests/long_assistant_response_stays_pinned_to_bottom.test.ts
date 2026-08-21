import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("long assistant response stays pinned to the bottom", () => {
    it("keeps the live composer healthy through scrollback growth and a follow-up turn", async () => {
        const longResponse = [
            "PINNED_RESPONSE_BEGIN",
            ...Array.from(
                { length: 180 },
                (_, index) =>
                    `- Pinned line ${String(index).padStart(3, "0")} keeps Unicode intact: Djibouti 🇩🇯 日本語 e\u0301.`,
            ),
            "PINNED_RESPONSE_END",
        ].join("\n");
        const gym = await createGym({
            cols: 72,
            inference: [
                { content: [{ text: longResponse, type: "text" }] },
                { content: [{ text: "PINNED_FOLLOW_UP_ACCEPTED", type: "text" }] },
            ],
            rows: 18,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        gym.terminal.type("Give me a long numbered response.");
        gym.terminal.press("enter");

        const firstTurn = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PINNED_RESPONSE_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "long response and idle composer at the bottom",
            30_000,
        );
        expect(firstTurn.rows).toHaveLength(18);
        expect(firstTurn.scroll.visibleRows).toBe(18);
        expect(firstTurn.scroll.totalRows).toBeGreaterThan(firstTurn.scroll.visibleRows);
        expect(firstTurn.scroll.offset + firstTurn.scroll.visibleRows).toBe(
            firstTurn.scroll.totalRows,
        );
        expect(firstTurn.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(firstTurn.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
        expect(firstTurn.text).toContain("gym off · /workspace");
        expect(firstTurn.text).not.toContain("\x1b[200~");
        expect(firstTurn.text).not.toContain("\x1b[201~");
        expect(firstTurn.text).not.toContain("�");
        expect(firstTurn.cursor.x).toBeLessThan(72);
        expect(firstTurn.cursor.y).toBeLessThan(18);

        gym.terminal.type("Confirm that input still works after the long response.");
        gym.terminal.press("enter");

        const followUp = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PINNED_FOLLOW_UP_ACCEPTED") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "follow-up response and idle composer at the bottom",
            30_000,
        );
        expect(followUp.rows).toHaveLength(18);
        expect(followUp.scroll.visibleRows).toBe(18);
        expect(followUp.scroll.offset + followUp.scroll.visibleRows).toBe(
            followUp.scroll.totalRows,
        );
        expect(followUp.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(followUp.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
        expect(followUp.text).toContain("gym off · /workspace");
        expect(followUp.text).not.toContain("�");
        expect(followUp.cursor.x).toBeLessThan(72);
        expect(followUp.cursor.y).toBeLessThan(18);
    }, 120_000);
});
