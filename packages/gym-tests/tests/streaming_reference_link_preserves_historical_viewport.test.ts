import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, waitForTerminalOutput, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("streaming prose resolves an earlier reference link while reading history", () => {
    it("does not clear scrollback or move the historical viewport", async () => {
        const releaseStream = deferred<void>();
        const streamRequestStarted = deferred<void>();
        const initialHistory = [
            "REFERENCE_HISTORY_BEGIN",
            ...Array.from(
                { length: 150 },
                (_, index) => `Stable history row ${String(index).padStart(3, "0")}`,
            ),
            "REFERENCE_HISTORY_END",
        ].join("\n");
        const streamedAnswer = [
            "Read [the viewport guide][guide] before continuing.",
            "",
            ...Array.from(
                { length: 100 },
                (_, index) =>
                    `Reference stream paragraph ${String(index).padStart(3, "0")} stays ordinary prose.`,
            ),
            "",
            "[guide]: https://example.test/viewport-guide",
            "REFERENCE_STREAM_END",
        ].join("\n");
        const gym = await createGym({
            cols: 68,
            inference: async (_request, callIndex) => {
                if (callIndex === 0) {
                    return { content: [{ text: initialHistory, type: "text" }] };
                }
                expect(callIndex).toBe(1);
                streamRequestStarted.resolve();
                await releaseStream.promise;
                return {
                    content: [{ text: streamedAnswer, type: "text" }],
                    textDeltaChunkSize: 24,
                    textDeltaDelayMs: 12,
                };
            },
            rows: 16,
        });
        running.add(gym);

        const output: string[] = [];
        const stopCapturingOutput = gym.terminal.onOutput((data) => output.push(data));

        submit(gym, "Create stable history for a viewport test.");
        await waitForIdleText(gym, "REFERENCE_HISTORY_END");
        submit(gym, "Stream the linked prose.");
        await streamRequestStarted.promise;
        releaseStream.resolve();

        await waitForTerminalOutput(gym, "Reference stream paragraph 060", 30_000);
        gym.terminal.scrollBy(-65);
        const anchored = await gym.terminal.snapshot();
        expect(anchored.scroll.atTop).toBe(false);
        expect(anchored.scroll.atBottom).toBe(false);
        const anchor = {
            offset: anchored.scroll.offset,
            rows: anchored.rows,
            text: anchored.text,
        };
        await writeProof(gym, "reference-01-anchored.png");

        await waitForTerminalOutput(gym, "REFERENCE_STREAM_END", 30_000);
        const completedWhileReading = await gym.terminal.snapshot();
        stopCapturingOutput();
        await writeProof(gym, "reference-02-after-resolution.png");
        await writeOutputTrace(output);

        expect(output.join("")).not.toContain("\x1b[2J\x1b[H\x1b[3J");
        expect(completedWhileReading.scroll.atTop).toBe(false);
        expect(completedWhileReading.scroll.atBottom).toBe(false);
        expect(completedWhileReading.scroll.offset).toBe(anchor.offset);
        expect(completedWhileReading.rows).toEqual(anchor.rows);
        expect(completedWhileReading.text).toBe(anchor.text);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

async function waitForIdleText(gym: Gym, text: string): Promise<void> {
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes(text) &&
            snapshot.text.includes("Ask Happy Terminal to do anything") &&
            snapshot.scroll.atBottom,
        `idle response containing ${text}`,
        30_000,
    );
}

async function writeProof(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(`${directory}/${name}`);
}

async function writeOutputTrace(chunks: readonly string[]): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await mkdir(directory, { recursive: true });
    await writeFile(
        `${directory}/reference-output-frames.json`,
        `${JSON.stringify(
            chunks.map((data, index) => ({
                data,
                index,
                clearsScrollback: data.includes("\x1b[3J"),
                synchronizedOutputBegin: data.includes("\x1b[?2026h"),
                synchronizedOutputEnd: data.includes("\x1b[?2026l"),
            })),
            null,
            2,
        )}\n`,
    );
}
