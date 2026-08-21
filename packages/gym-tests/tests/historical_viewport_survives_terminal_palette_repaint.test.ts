import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, waitForTerminalOutput, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal palette repaint while reading history", () => {
    it("keeps the exact middle viewport without clearing scrollback", async () => {
        const releaseActiveTurn = deferred<void>();
        const activeTurnStarted = deferred<void>();
        const history = [
            "PALETTE_HISTORY_BEGIN",
            ...Array.from(
                { length: 150 },
                (_, index) => `Palette history row ${String(index).padStart(3, "0")}`,
            ),
            "PALETTE_HISTORY_END",
        ].join("\n");
        const gym = await createGym({
            cols: 68,
            inference: async (_request, callIndex) => {
                if (callIndex === 0) return { content: [{ text: history, type: "text" }] };
                activeTurnStarted.resolve();
                await releaseActiveTurn.promise;
                return { content: [{ text: "PALETTE_ACTIVE_TURN_COMPLETE", type: "text" }] };
            },
            rows: 16,
            terminalColorScheme: "light",
        });
        running.add(gym);

        submit(gym, "Create history for a terminal palette transition.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PALETTE_HISTORY_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "palette history at the bottom",
            30_000,
        );

        submit(gym, "Keep working while the terminal palette changes.");
        await activeTurnStarted.promise;
        await gym.terminal.waitForText("Working", 30_000);
        gym.terminal.scrollBy(-65);
        const anchored = await gym.terminal.snapshot();
        expect(anchored.scroll.atTop).toBe(false);
        expect(anchored.scroll.atBottom).toBe(false);
        const anchor = {
            bottomDepartureCount: anchored.scroll.bottomDepartureCount,
            offset: anchored.scroll.offset,
            rows: anchored.rows,
            text: anchored.text,
            topArrivalCount: anchored.scroll.topArrivalCount,
        };
        await writeProof(gym, "palette-01-light-anchored.png");

        const output: string[] = [];
        const stopOutputCapture = gym.terminal.onOutput((data) => output.push(data));
        gym.terminal.setColorScheme("dark");
        const repainted = await gym.terminal.waitUntil(
            (snapshot) => snapshot.outputRevision > anchored.outputRevision + 1,
            "the dark palette repaint",
            10_000,
        );
        assertAnchor(repainted, anchor);
        expect(output.join("")).not.toContain("\x1b[3J");
        expect(output.join("")).not.toContain("\x1b[2J\x1b[H");
        await writeProof(gym, "palette-02-dark-anchored.png");

        gym.terminal.setColorScheme("light");
        const restored = await gym.terminal.waitUntil(
            (snapshot) => snapshot.outputRevision > repainted.outputRevision + 1,
            "the restored light palette repaint",
            10_000,
        );
        assertAnchor(restored, anchor);
        expect(output.join("")).not.toContain("\x1b[3J");
        stopOutputCapture();

        releaseActiveTurn.resolve();
        await waitForTerminalOutput(gym, "PALETTE_ACTIVE_TURN_COMPLETE", 30_000);
        const completedWhileReading = await gym.terminal.snapshot();
        assertAnchor(completedWhileReading, anchor);

        gym.terminal.scrollToBottom();
        const bottom = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PALETTE_ACTIVE_TURN_COMPLETE") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "current live tail after palette repaint",
            30_000,
        );
        expect(bottom.scroll.offset + bottom.scroll.visibleRows).toBe(bottom.scroll.totalRows);
        expect(bottom.text).not.toContain("�");
        await writeProof(gym, "palette-03-returned-to-bottom.png");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function assertAnchor(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    anchor: {
        bottomDepartureCount: number;
        offset: number;
        rows: readonly string[];
        text: string;
        topArrivalCount: number;
    },
): void {
    expect(snapshot.scroll.atTop).toBe(false);
    expect(snapshot.scroll.atBottom).toBe(false);
    expect(snapshot.scroll.offset).toBe(anchor.offset);
    expect(snapshot.scroll.bottomDepartureCount).toBe(anchor.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(anchor.topArrivalCount);
    expect(snapshot.rows).toEqual(anchor.rows);
    expect(snapshot.text).toBe(anchor.text);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolvePromiseValue) => {
        resolvePromise = resolvePromiseValue;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

async function writeProof(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
}
