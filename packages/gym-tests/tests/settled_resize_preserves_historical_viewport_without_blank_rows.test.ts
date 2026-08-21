import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("settled resize while reading scrollback", () => {
    it("rebuilds historical rows from source without adding blanks per resize event", async () => {
        const control = await createResizeGym(52);
        running.add(control);
        await seedHistory(control);
        control.terminal.scrollBy(-40);
        const controlReading = await waitForHistoricalViewport(control);
        submit(control, "Hold this follow-up while resize settles.");
        const controlSettled = await waitForOutputRevisions(
            control,
            controlReading.outputRevision + 25,
            52,
        );
        const controlRowsAtFinalSize = controlSettled.scroll.totalRows;
        control.terminal.press("escape");

        const gym = await createResizeGym(80);
        running.add(gym);
        await seedHistory(gym);
        gym.terminal.scrollBy(-40);
        const reading = await waitForHistoricalViewport(gym);
        const anchor = /RESIZE HISTORY \d{3}/u.exec(resizeHistoryRows(reading)[0] ?? "")?.[0];
        expect(anchor).toBeDefined();
        if (anchor === undefined) throw new Error("Historical resize anchor was not rendered.");

        gym.terminal.resize(44, 12);
        gym.terminal.resize(112, 28);
        gym.terminal.resize(52, 20);
        submit(gym, "Hold this follow-up while resize settles.");

        const settled = await waitForOutputRevisions(gym, reading.outputRevision + 25, 52);
        const rebuiltRows = await collectScrollbackRows(gym);
        expect(settled.scroll.totalRows).toBeLessThanOrEqual(
            controlRowsAtFinalSize + settled.rows.length,
        );
        expect(rebuiltRows.filter((row) => row.trim().length === 0).length).toBeLessThanOrEqual(
            settled.rows.length,
        );
        expect(rebuiltRows.filter((row) => row.includes(anchor))).toHaveLength(1);
        expect(rebuiltRows.filter((row) => row.includes("RESIZE HISTORY"))).toHaveLength(120);

        gym.terminal.press("escape");
        gym.terminal.scrollToBottom();
        const stopped = await gym.terminal.waitForText("Session interrupted", 30_000);
        expect(stopped.text).not.toContain("RESIZE_PROBE_MUST_STAY_PENDING");
    }, 120_000);
});

function createResizeGym(cols: number): Promise<Gym> {
    const history = Array.from(
        { length: 120 },
        (_, index) =>
            `RESIZE HISTORY ${String(index).padStart(3, "0")} has enough stable text to wrap at the final narrow width.`,
    ).join("\n");
    return createGym({
        mode: "docker",
        cols,
        inference: [
            { content: [{ text: history, type: "text" }] },
            {
                content: [{ text: "RESIZE_PROBE_MUST_STAY_PENDING", type: "text" }],
                delayMs: 10_000,
            },
        ],
        rows: 20,
    });
}

async function seedHistory(gym: Gym): Promise<void> {
    submit(gym, "Create resize history.");
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes("RESIZE HISTORY 119") &&
            snapshot.text.includes("Ask Happy Terminal to do anything") &&
            snapshot.scroll.atBottom,
        "resize history and idle composer",
        30_000,
    );
}

function waitForHistoricalViewport(
    gym: Gym,
): Promise<Awaited<ReturnType<Gym["terminal"]["snapshot"]>>> {
    return gym.terminal.waitUntil(
        (snapshot) => !snapshot.scroll.atBottom && resizeHistoryRows(snapshot).length > 0,
        "a historical resize marker in the viewport",
    );
}

function waitForOutputRevisions(
    gym: Gym,
    revision: number,
    columns: number,
): Promise<Awaited<ReturnType<Gym["terminal"]["snapshot"]>>> {
    return gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.rows.length === 20 &&
            snapshot.rows.every((row) => [...row].length <= columns) &&
            snapshot.outputRevision >= revision,
        "the final resize to settle while inference remains active",
        30_000,
    );
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function resizeHistoryRows(snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>): string[] {
    return snapshot.rows.filter((row) => row.includes("RESIZE HISTORY"));
}

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
