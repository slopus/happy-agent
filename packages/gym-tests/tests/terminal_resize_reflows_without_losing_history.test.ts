import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal resize rebuilds from source", () => {
    it("redraws one complete copy of the transcript through narrow and wide layouts", async () => {
        const response = [
            "REFLOW_HISTORY_BEGIN",
            ...Array.from(
                { length: 120 },
                (_, index) =>
                    `- Reflow line ${String(index).padStart(3, "0")} has enough text to wrap in a narrow terminal.`,
            ),
            "REFLOW_UNIQUE_MIDDLE_MARKER",
            ...Array.from(
                { length: 60 },
                (_, index) => `- Reflow tail ${String(index).padStart(3, "0")}`,
            ),
            "REFLOW_HISTORY_END",
        ].join("\n");
        const gym = await createGym({
            cols: 84,
            inference: [
                { content: [{ text: response, type: "text" }] },
                { content: [{ text: "REFLOW_FOLLOW_UP_ACCEPTED", type: "text" }] },
            ],
            rows: 20,
        });
        running.add(gym);
        gym.terminal.type("Create a transcript that can be checked across resizes.");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("REFLOW_HISTORY_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "initial reflow transcript and idle composer",
            30_000,
        );

        const resizeOutput: string[] = [];
        const stopResizeOutput = gym.terminal.onOutput((data) => resizeOutput.push(data));
        gym.terminal.resize(44, 14);
        const narrow = await settleResize(gym, 44, 14, "narrow-settled");
        stopResizeOutput();
        expect(resizeOutput.join("")).toContain("\x1b[2J\x1b[H\x1b[3J");
        expect(narrow.scroll.totalRows).toBeGreaterThan(narrow.scroll.visibleRows);
        expect(narrow.scroll.offset + narrow.scroll.visibleRows).toBe(narrow.scroll.totalRows);
        expect(narrow.text).toContain("gym off · /workspace");
        expect(narrow.text).not.toContain("�");
        expect(narrow.cursor.x).toBeLessThan(44);
        expect(narrow.cursor.y).toBeLessThan(14);

        const narrowHistory = await captureScrollback(gym);
        expect(countOccurrences(narrowHistory, "REFLOW_HISTORY_BEGIN")).toBe(1);
        expect(countOccurrences(narrowHistory, "REFLOW_UNIQUE_MIDDLE_MARKER")).toBe(1);
        expect(countOccurrences(narrowHistory, "REFLOW_HISTORY_END")).toBe(1);
        expect(narrowHistory).not.toContain("narrow-settled");

        gym.terminal.resize(112, 28);
        const wide = await settleResize(gym, 112, 28, "wide-settled");
        expect(wide.scroll.totalRows).toBeGreaterThan(wide.scroll.visibleRows);
        expect(wide.scroll.offset + wide.scroll.visibleRows).toBe(wide.scroll.totalRows);
        expect(wide.text).toContain("gym off · /workspace");
        expect(wide.text).not.toContain("�");
        expect(wide.cursor.x).toBeLessThan(112);
        expect(wide.cursor.y).toBeLessThan(28);

        const wideHistory = await captureScrollback(gym);
        expect(countOccurrences(wideHistory, "REFLOW_HISTORY_BEGIN")).toBe(1);
        expect(countOccurrences(wideHistory, "REFLOW_UNIQUE_MIDDLE_MARKER")).toBe(1);
        expect(countOccurrences(wideHistory, "REFLOW_HISTORY_END")).toBe(1);
        expect(wideHistory).not.toContain("wide-settled");

        gym.terminal.type("Confirm input still works after both resizes.");
        gym.terminal.press("enter");
        const followUp = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("REFLOW_FOLLOW_UP_ACCEPTED") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "follow-up response after narrow and wide resizes",
            30_000,
        );
        expect(followUp.rows).toHaveLength(28);
        expect(followUp.scroll.visibleRows).toBe(28);
        expect(followUp.scroll.offset + followUp.scroll.visibleRows).toBe(
            followUp.scroll.totalRows,
        );
        expect(followUp.text).toContain("gym off · /workspace");
        expect(followUp.text).not.toContain("�");
        expect(followUp.cursor.x).toBeLessThan(112);
        expect(followUp.cursor.y).toBeLessThan(28);
    }, 120_000);
});

async function settleResize(
    gym: Gym,
    columns: number,
    rows: number,
    marker: string,
): Promise<Awaited<ReturnType<Gym["terminal"]["snapshot"]>>> {
    gym.terminal.type(marker);
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.rows.length === rows &&
            snapshot.scroll.visibleRows === rows &&
            snapshot.text.includes(marker) &&
            snapshot.scroll.atBottom,
        `the ${columns} by ${rows} resize to render a draft`,
        30_000,
    );
    for (const _character of marker) gym.terminal.press("backspace");
    return gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.rows.length === rows &&
            snapshot.scroll.visibleRows === rows &&
            !snapshot.text.includes(marker) &&
            snapshot.text.includes("Ask Happy Terminal to do anything") &&
            snapshot.scroll.atBottom,
        `healthy ${columns} by ${rows} layout at the bottom`,
        30_000,
    );
}

function countOccurrences(text: string, search: string): number {
    return text.split(search).length - 1;
}
