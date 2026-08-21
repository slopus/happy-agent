import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("vertical resize", () => {
    it("keeps the source-backed transcript compact when the session fits again", async () => {
        const gym = await createGym({
            cols: 80,
            inference: [
                { content: [{ text: "VERTICAL_RESIZE_REPLY", type: "text" }] },
                { content: [{ text: "VERTICAL_RESIZE_FOLLOW_UP", type: "text" }] },
            ],
            rows: 14,
        });
        running.add(gym);

        submit(gym, "short resize turn");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("VERTICAL_RESIZE_REPLY") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the short session at the initial compact height",
            30_000,
        );

        const grown = await settleVerticalResize(gym, 30, "first-grow-settled");
        expect(grown.scroll.atBottom).toBe(true);
        expect(grown.text).toContain("› short resize turn");
        expect(grown.text).toContain("VERTICAL_RESIZE_REPLY");
        expect(maximumBlankRunBeforeComposer(grown.rows)).toBeLessThanOrEqual(2);
        const grownScrollback = await captureScrollback(gym);
        expect(countOccurrences(grownScrollback, "short resize turn")).toBe(1);
        expect(countOccurrences(grownScrollback, "VERTICAL_RESIZE_REPLY")).toBe(1);

        await settleVerticalResize(gym, 12, "shrink-settled");

        const regrown = await settleVerticalResize(gym, 30, "second-grow-settled");
        expect(maximumBlankRunBeforeComposer(regrown.rows)).toBeLessThanOrEqual(2);
        const regrownScrollback = await captureScrollback(gym);
        expect(countOccurrences(regrownScrollback, "short resize turn")).toBe(1);
        expect(countOccurrences(regrownScrollback, "VERTICAL_RESIZE_REPLY")).toBe(1);

        submit(gym, "still usable after vertical resize");
        const followUp = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("VERTICAL_RESIZE_FOLLOW_UP") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "a follow-up turn after vertical resizes",
            30_000,
        );
        expect(followUp.text).not.toContain("�");
    }, 120_000);

    it("keeps an overflowing transcript compact without replaying history", async () => {
        const response = [
            "LONG_VERTICAL_RESIZE_BEGIN",
            ...Array.from(
                { length: 60 },
                (_, index) => `- LONG_VERTICAL_RESIZE_LINE_${String(index).padStart(2, "0")}`,
            ),
            "LONG_VERTICAL_RESIZE_UNIQUE_MIDDLE",
            "LONG_VERTICAL_RESIZE_END",
        ].join("\n");
        const gym = await createGym({
            cols: 80,
            inference: [
                { content: [{ text: response, type: "text" }] },
                { content: [{ text: "LONG_VERTICAL_RESIZE_FOLLOW_UP", type: "text" }] },
            ],
            rows: 14,
        });
        running.add(gym);

        submit(gym, "long resize turn");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("LONG_VERTICAL_RESIZE_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the overflowing session at the initial compact height",
            30_000,
        );

        const grown = await settleVerticalResize(gym, 30, "long-grow-settled");
        expect(grown.text).toContain("LONG_VERTICAL_RESIZE_END");
        expect(maximumBlankRunBeforeComposer(grown.rows)).toBeLessThanOrEqual(2);

        const scrollback = await captureScrollback(gym);
        expect(countOccurrences(scrollback, "LONG_VERTICAL_RESIZE_BEGIN")).toBe(1);
        expect(countOccurrences(scrollback, "LONG_VERTICAL_RESIZE_UNIQUE_MIDDLE")).toBe(1);
        expect(countOccurrences(scrollback, "LONG_VERTICAL_RESIZE_END")).toBe(1);

        submit(gym, "still usable after the long resize");
        const followUp = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("LONG_VERTICAL_RESIZE_FOLLOW_UP") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "a follow-up turn after the overflowing session resize",
            30_000,
        );
        expect(followUp.text).not.toContain("�");

        const finalScrollback = await captureScrollback(gym);
        expect(countOccurrences(finalScrollback, "LONG_VERTICAL_RESIZE_BEGIN")).toBe(1);
        expect(countOccurrences(finalScrollback, "LONG_VERTICAL_RESIZE_UNIQUE_MIDDLE")).toBe(1);
        expect(countOccurrences(finalScrollback, "LONG_VERTICAL_RESIZE_END")).toBe(1);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function settleVerticalResize(
    gym: Gym,
    rows: number,
    marker: string,
): Promise<Awaited<ReturnType<Gym["terminal"]["snapshot"]>>> {
    gym.terminal.resize(80, rows);
    gym.terminal.type(marker);
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.rows.length === rows &&
            snapshot.text.includes(marker) &&
            snapshot.scroll.atBottom,
        `the ${rows}-row vertical resize to settle`,
        30_000,
    );
    for (const _character of marker) gym.terminal.press("backspace");
    return gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.rows.length === rows &&
            !snapshot.text.includes(marker) &&
            snapshot.text.includes("Ask Happy Terminal to do anything") &&
            snapshot.scroll.atBottom,
        `the ${rows}-row layout to return to an empty composer`,
        30_000,
    );
}

function composerRow(rows: readonly string[]): number {
    return rows.findIndex((row) => row.includes("Ask Happy Terminal to do anything"));
}

function maximumBlankRunBeforeComposer(rows: readonly string[]): number {
    const end = composerRow(rows);
    if (end < 0) return rows.length;
    let maximum = 0;
    let current = 0;
    for (const row of rows.slice(0, end)) {
        current = row.trim().length === 0 ? current + 1 : 0;
        maximum = Math.max(maximum, current);
    }
    return maximum;
}

function countOccurrences(value: string, search: string): number {
    return value.split(search).length - 1;
}
