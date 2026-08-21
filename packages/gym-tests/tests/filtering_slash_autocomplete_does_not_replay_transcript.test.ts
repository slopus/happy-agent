import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("filtering slash autocomplete does not replay transcript", () => {
    it("keeps one history copy when the visible suggestion count shrinks", async () => {
        const response = Array.from(
            { length: 30 },
            (_, index) => `SLASH HISTORY ${String(index).padStart(2, "0")}`,
        ).join("\n");
        const gym = await createGym({
            cols: 60,
            inference: [
                { content: [{ text: response, type: "text" }] },
                { content: [{ text: "SLASH_FOLLOW_UP_OK", type: "text" }] },
            ],
            rows: 12,
        });
        running.add(gym);

        gym.terminal.type("seed slash history");
        gym.terminal.press("enter");
        const history = await gym.terminal.waitForText("SLASH HISTORY 29", 30_000);
        const baselineScroll = history.scroll;

        gym.terminal.type("/");
        await gym.terminal.waitForText("/model", 30_000);
        gym.terminal.type("c");
        const filtered = await gym.terminal.waitForText("/clear", 30_000);
        expect(filtered.scroll.atBottom).toBe(true);
        expect(filtered.scroll.bottomDepartureCount).toBe(baselineScroll.bottomDepartureCount);
        expect(filtered.scroll.topArrivalCount).toBe(baselineScroll.topArrivalCount);

        gym.terminal.press("ctrlC");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything");
        gym.terminal.type("follow up after filtering");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SLASH_FOLLOW_UP_OK", 30_000);

        const scrollbackRows = await collectScrollbackRows(gym);
        expect.soft(countExactRow(scrollbackRows, "› seed slash history")).toBe(1);
        expect.soft(countExactRow(scrollbackRows, "• SLASH HISTORY 00")).toBe(1);
        expect.soft(countExactRow(scrollbackRows, "SLASH HISTORY 29")).toBe(1);

        gym.terminal.scrollToBottom();
        const bottom = await gym.terminal.snapshot();
        expect(bottom.scroll.atBottom).toBe(true);
        expect(bottom.text).toContain("SLASH_FOLLOW_UP_OK");
        expect(bottom.text).toContain("Ask Happy Terminal to do anything");
        expect(bottom.text).toContain("gym off · /workspace");
        expect(bottom.text).not.toContain("�");
    }, 120_000);
});

async function collectScrollbackRows(gym: Gym): Promise<string[]> {
    gym.terminal.scrollToTop();
    let snapshot = await gym.terminal.snapshot();
    const rows: string[] = [];

    for (;;) {
        if (snapshot.scroll.atBottom) {
            rows.push(...snapshot.rows);
            return rows;
        }

        rows.push(snapshot.rows[0] ?? "");
        const previousOffset = snapshot.scroll.offset;
        gym.terminal.scrollBy(1);
        snapshot = await gym.terminal.snapshot();
        if (snapshot.scroll.offset === previousOffset) {
            throw new Error(`Scrollback stopped advancing at offset ${previousOffset}.`);
        }
    }
}

function countExactRow(rows: readonly string[], value: string): number {
    return rows.filter((row) => row.trim() === value).length;
}
