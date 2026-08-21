import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    captureScrollback,
    createGym,
    waitForTerminalOutput,
    type Gym,
} from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("visible streamed reasoning while reading terminal history", () => {
    it("keeps prose, tables, lists, wrapping, and late references append-only through settlement", async () => {
        const history = [
            "REASONING_HISTORY_BEGIN",
            ...Array.from(
                { length: 120 },
                (_, index) =>
                    `REASONING_HISTORY_${String(index).padStart(3, "0")} stable old row for anchoring`,
            ),
            "REASONING_HISTORY_END",
        ].join("\n");
        const thinking = [
            "THINKING_STREAM_BEGIN",
            "A [late reasoning reference][reasoning-target] starts unresolved.",
            ...Array.from(
                { length: 32 },
                (_, index) =>
                    `Reasoning prose ${String(index).padStart(3, "0")} wraps with deliberate extra words across the narrow terminal width.`,
            ),
            "",
            "| Step | Evidence |",
            "| --- | --- |",
            "| one | short |",
            "| two | a substantially longer cell that changes the streamed table layout |",
            "",
            "1. First streamed list item",
            "2. Second streamed list item with enough text to wrap onto another terminal row",
            "3. Third streamed list item",
            "",
            "THINKING_STREAM_END",
            "",
            "[reasoning-target]: https://example.com/reasoning",
        ].join("\n");
        const gym = await createGym({
            cols: 58,
            homeFiles: {
                "Happy/Config/happy.toml": "[settings]\nshow_reasoning = true\n",
            },
            inference: [
                { content: [{ text: history, type: "text" }] },
                {
                    content: [
                        { thinking, type: "thinking" },
                        { text: "REASONING_ASSISTANT_COMPLETE", type: "text" },
                    ],
                    thinkingDeltaChunkSize: 24,
                    thinkingDeltaDelayMs: 20,
                },
                { content: [{ text: "REASONING_FOLLOW_UP", type: "text" }] },
            ],
            rows: 14,
        });
        running.add(gym);

        submit(gym, "Create stable history before reasoning.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("REASONING_HISTORY_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "reasoning history at the bottom",
            30_000,
        );

        const output: string[] = [];
        const stopOutputCapture = gym.terminal.onOutput((data) => output.push(data));
        submit(gym, "Stream visible reasoning markdown.");
        await gym.terminal.waitForText("Reasoning prose 005", 30_000);

        gym.terminal.scrollToTop();
        gym.terminal.scrollBy(54);
        const anchored = await gym.terminal.snapshot();
        expect(anchored.scroll.atTop).toBe(false);
        expect(anchored.scroll.atBottom).toBe(false);
        expect(anchored.text).toContain("REASONING_HISTORY_");
        const anchorMarker = /REASONING_HISTORY_\d{3}/u.exec(anchored.text)?.[0];
        expect(anchorMarker).toBeDefined();
        if (anchorMarker === undefined) throw new Error("Reasoning anchor marker was not visible.");
        await screenshot(gym, "reasoning-01-anchored.png");

        await waitForTerminalOutput(gym, "REASONING_ASSISTANT_COMPLETE", 30_000);
        const settled = await gym.terminal.snapshot();
        expect(settled.rows).toEqual(anchored.rows);
        expect(settled.text).toBe(anchored.text);
        expect(settled.scroll.offset).toBe(anchored.scroll.offset);
        expect(settled.scroll.bottomDepartureCount).toBe(anchored.scroll.bottomDepartureCount);
        expect(settled.scroll.topArrivalCount).toBe(anchored.scroll.topArrivalCount);
        expect(output.join("")).not.toContain("\x1b[3J");
        expect(output.join("")).not.toContain("\x1b[2J\x1b[H");
        stopOutputCapture();
        await screenshot(gym, "reasoning-02-settled-while-anchored.png");

        gym.terminal.scrollToBottom();
        const bottom = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("REASONING_ASSISTANT_COMPLETE") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the settled reasoning tail after returning to the bottom",
            30_000,
        );
        expect(bottom.scroll.offset + bottom.scroll.visibleRows).toBe(bottom.scroll.totalRows);
        await screenshot(gym, "reasoning-03-returned-to-bottom.png");

        submit(gym, "Render a later revision after reasoning settlement.");
        const revised = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("REASONING_FOLLOW_UP") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "a later healthy revision after reasoning settlement",
            30_000,
        );
        expect(revised.text).not.toContain("�");

        const scrollback = await captureScrollback(gym);
        expect(countOccurrences(scrollback, anchorMarker)).toBe(1);
        expect(countOccurrences(scrollback, "THINKING_STREAM_BEGIN")).toBe(1);
        expect(countOccurrences(scrollback, "THINKING_STREAM_END")).toBe(1);
        expect(countOccurrences(scrollback, "REASONING_ASSISTANT_COMPLETE")).toBe(1);
        expect(countOccurrences(scrollback, "REASONING_FOLLOW_UP")).toBe(1);
        expect(scrollback).toContain("late reasoning reference");
        expect(scrollback).toContain("substantially longer cell");
        expect(scrollback).toContain("Third streamed list item");
        expect(maximumBlankRun(scrollback)).toBeLessThanOrEqual(4);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function screenshot(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
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
