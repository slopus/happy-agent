import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("resize while reading scrollback", () => {
    it("rebuilds the authoritative transcript and keeps later messages visible", async () => {
        const history = [
            "RESIZE_REBUILD_BEGIN",
            ...Array.from(
                { length: 100 },
                (_, index) =>
                    `RESIZE_REBUILD_${String(index).padStart(3, "0")} source-backed text that wraps at narrow widths`,
            ),
            "RESIZE_REBUILD_END",
        ].join("\n");
        const gym = await createGym({
            cols: 72,
            inference: [
                { content: [{ text: history, type: "text" }] },
                { content: [{ text: "RESIZE_REBUILD_FOLLOW_UP", type: "text" }] },
            ],
            rows: 18,
        });
        running.add(gym);

        submit(gym, "Create history before the resize.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("RESIZE_REBUILD_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the initial transcript at the bottom",
            30_000,
        );

        gym.terminal.scrollToTop();
        gym.terminal.scrollBy(40);
        expect((await gym.terminal.snapshot()).scroll.atBottom).toBe(false);

        const resizeOutput: string[] = [];
        const stopResizeOutput = gym.terminal.onOutput((data) => resizeOutput.push(data));
        gym.terminal.resize(52, 14);
        const resized = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.rows.length === 14 &&
                snapshot.text.includes("RESIZE_REBUILD_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the source-backed transcript after the resize",
            30_000,
        );
        stopResizeOutput();

        expect(resizeOutput.join("")).toContain("\x1b[2J\x1b[H\x1b[3J");
        expect(resized.text).not.toContain("�");

        submit(gym, "Keep messages visible after the resize.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("RESIZE_REBUILD_FOLLOW_UP") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the follow-up message and answer",
            30_000,
        );

        const transcript = await captureScrollback(gym);
        expect(countOccurrences(transcript, "RESIZE_REBUILD_BEGIN")).toBe(1);
        expect(countOccurrences(transcript, "RESIZE_REBUILD_END")).toBe(1);
        expect(countOccurrences(transcript, "Keep messages visible after the resize.")).toBe(1);
        expect(countOccurrences(transcript, "RESIZE_REBUILD_FOLLOW_UP")).toBe(1);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function countOccurrences(value: string, search: string): number {
    return value.split(search).length - 1;
}
