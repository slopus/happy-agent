import { describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

describe("width resize with a changing live-tail height", () => {
    it("preserves history and queued rows when the popup grows and shrinks the painted tail", async () => {
        const releaseInference = deferred<void>();
        const queuedPrompt = "QUEUE_AFTER_WIDTH_RESIZE";
        const history = [
            "WIDTH_RESIZE_HISTORY_BEGIN",
            ...Array.from(
                { length: 60 },
                (_, index) =>
                    `WIDTH_RESIZE_HISTORY_${String(index).padStart(2, "0")} stable content that reflows at narrow widths`,
            ),
            "WIDTH_RESIZE_HISTORY_MIDDLE",
            "WIDTH_RESIZE_HISTORY_END",
        ].join("\n");
        const gym = await createGym({
            cols: 86,
            files: {
                "src/ResizeAlpha.ts": "export const alpha = true;\n",
                "src/ResizeBeta.ts": "export const beta = true;\n",
                "src/ResizeGamma.ts": "export const gamma = true;\n",
            },
            async inference(_request, callIndex) {
                if (callIndex === 0) return { content: [{ text: history, type: "text" }] };
                await releaseInference.promise;
                return { content: [{ text: "WIDTH_RESIZE_GATE_RELEASED", type: "text" }] };
            },
            rows: 28,
        });

        try {
            submit(gym, "Create width resize history.");
            await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("WIDTH_RESIZE_HISTORY_END") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything") &&
                    snapshot.scroll.atBottom,
                "overflowing width-resize history at the bottom",
                30_000,
            );

            submit(gym, "Keep inference active while the live tail changes height.");
            await gym.terminal.waitForText("esc to interrupt", 30_000);
            submit(gym, queuedPrompt);
            await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("Messages to be submitted after next tool call") &&
                    snapshot.text.includes(queuedPrompt) &&
                    snapshot.text.includes("Ask Happy Terminal to do anything"),
                "the queued prompt above the composer",
                30_000,
            );
            gym.terminal.type("@resize");
            await gym.terminal.waitForText("ResizeAlpha.ts", 30_000);
            gym.terminal.resize(52, 28);
            const narrow = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.rows.length === 28 &&
                    snapshot.scroll.visibleRows === 28 &&
                    snapshot.text.includes("ResizeAlpha.ts") &&
                    snapshot.text.includes(queuedPrompt) &&
                    snapshot.scroll.atBottom,
                "the narrow layout with the tall autocomplete tail",
                30_000,
            );
            assertHealthyLiveTail(narrow, queuedPrompt, 52);
            await assertUniqueHistory(gym, queuedPrompt, 1);

            // During active inference Escape delivers steering, so Ctrl-C dismisses autocomplete.
            gym.terminal.press("ctrlC");
            gym.terminal.resize(94, 28);
            const wide = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.rows.length === 28 &&
                    snapshot.scroll.visibleRows === 28 &&
                    !snapshot.text.includes("ResizeAlpha.ts") &&
                    snapshot.text.includes("Messages to be submitted after next tool call") &&
                    snapshot.text.includes(queuedPrompt) &&
                    snapshot.text.includes("gym off") &&
                    snapshot.scroll.atBottom,
                "the wide layout after the autocomplete tail closes",
                30_000,
            );
            assertHealthyLiveTail(wide, queuedPrompt, 94);
            await assertUniqueHistory(gym, queuedPrompt, 1);
        } finally {
            releaseInference.resolve();
            await gym.dispose();
        }
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function assertHealthyLiveTail(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    queuedPrompt: string | undefined,
    columns: number,
): void {
    const activeRow = rowContaining(snapshot.rows, "esc to interrupt");
    const composerRow = snapshot.rows.findIndex(
        (row) =>
            row.includes("Ask Happy Terminal to do anything") || row.trimStart().startsWith("› @"),
    );
    const footerRow = snapshot.rows.findIndex((row) => row.includes("gym off"));

    expect(composerRow).toBeGreaterThanOrEqual(0);
    expect(activeRow).toBeLessThan(composerRow);
    if (queuedPrompt !== undefined) {
        const queuedRow = rowContaining(snapshot.rows, queuedPrompt);
        expect(activeRow).toBeLessThan(queuedRow);
        expect(queuedRow).toBeLessThan(composerRow);
        expect(
            snapshot.rows.filter((row) => row.includes(queuedPrompt)),
            snapshot.rows.join("\n"),
        ).toHaveLength(1);
    }
    if (footerRow >= 0) expect(composerRow).toBeLessThan(footerRow);
    expect(
        snapshot.rows.filter(
            (row) =>
                row.includes("Ask Happy Terminal to do anything") ||
                row.trimStart().startsWith("› @"),
        ),
    ).toHaveLength(1);
    expect(snapshot.scroll.offset + snapshot.scroll.visibleRows).toBe(snapshot.scroll.totalRows);
    expect(snapshot.rows.every((row) => [...row].length <= columns)).toBe(true);
    expect(snapshot.cursor.x).toBeLessThan(columns);
    expect(snapshot.cursor.y).toBeLessThan(snapshot.rows.length);
    expect(snapshot.text).not.toContain("�");
}

async function assertUniqueHistory(
    gym: Gym,
    queuedPrompt: string,
    queuedPromptCount: number,
): Promise<void> {
    const scrollback = await captureScrollback(gym);
    expect(countOccurrences(scrollback, "WIDTH_RESIZE_HISTORY_BEGIN")).toBe(1);
    expect(countOccurrences(scrollback, "WIDTH_RESIZE_HISTORY_MIDDLE")).toBe(1);
    expect(countOccurrences(scrollback, "WIDTH_RESIZE_HISTORY_END")).toBe(1);
    expect(countOccurrences(scrollback, queuedPrompt)).toBe(queuedPromptCount);
    expect(maximumBlankRun(scrollback)).toBeLessThanOrEqual(4);
}

function rowContaining(rows: readonly string[], text: string): number {
    const row = rows.findIndex((candidate) => candidate.includes(text));
    expect(row, rows.join("\n")).toBeGreaterThanOrEqual(0);
    return row;
}

function countOccurrences(value: string, search: string): number {
    return value.split(search).length - 1;
}

function maximumBlankRun(value: string): number {
    let maximum = 0;
    let current = 0;
    for (const row of value.split("\n")) {
        current = row.trim().length === 0 ? current + 1 : 0;
        maximum = Math.max(maximum, current);
    }
    return maximum;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
