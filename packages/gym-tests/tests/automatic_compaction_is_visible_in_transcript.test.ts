import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
    createGym,
    renderTerminalSnapshotPng,
    type Gym,
    type TerminalSnapshot,
} from "@slopus/rig-gym";
import type { GymInferenceRequest } from "../../rig/sources/agent/gym-types.js";

const running = new Set<Gym>();
const usageArtifacts = resolve(import.meta.dirname, "../../artifacts/session-usage");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("automatic conversation compaction", () => {
    it("compacts before a new turn when the last provider context crossed the threshold", async () => {
        const requests: GymInferenceRequest[] = [];
        const secondRequestStarted = deferred<GymInferenceRequest>();
        const gym = await createGym({
            cols: 92,
            contextWindow: 40_000,
            inference(request, callIndex) {
                requests.push(request);
                if (callIndex === 0) {
                    return {
                        content: [{ text: "First turn complete.", type: "text" }],
                        contextTokens: 8_000,
                        usage: usage(100, 20),
                    };
                }
                if (callIndex === 1) {
                    secondRequestStarted.resolve(request);
                    if (request.options.intent === "compaction") {
                        return {
                            compactionContext: {
                                ...request.context,
                                messages: [
                                    {
                                        role: "user",
                                        content: "The first turn was summarized.",
                                        timestamp: 1,
                                    },
                                ],
                            },
                            content: [],
                        };
                    }
                    return {
                        content: [{ text: "Inference ran before compaction.", type: "text" }],
                    };
                }
                expect(callIndex).toBe(2);
                expect(request.options.intent).not.toBe("compaction");
                return {
                    content: [{ text: "Second turn used compacted context.", type: "text" }],
                    usage: usage(200, 30),
                };
            },
            rows: 26,
        });
        running.add(gym);

        submit(gym, "Finish a turn near the context limit.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("First turn complete.") &&
                !snapshot.text.includes("esc to interrupt"),
            "the first turn to settle",
            30_000,
        );

        submit(gym, "Continue after the context crossed the compaction threshold.");
        const secondRequest = await secondRequestStarted.promise;
        expect(secondRequest.options.intent).toBe("compaction");

        await gym.terminal.waitForText("Second turn used compacted context.", 30_000);
        expect(requests.map((request) => request.options.intent ?? "inference")).toEqual([
            "inference",
            "compaction",
            "inference",
        ]);
    }, 120_000);

    it("shows a durable transcript row when a small context window triggers compaction", async () => {
        const firstResponseStarted = deferred<void>();
        const releaseFirstResponse = deferred<void>();
        const compactionStarted = deferred<void>();
        const releaseCompaction = deferred<void>();
        let firstInferenceContext: GymInferenceRequest["context"] | undefined;
        const gym = await createGym({
            cols: 92,
            contextWindow: 500,
            async inference(request, callIndex) {
                if (callIndex === 0) {
                    firstInferenceContext = request.context;
                    firstResponseStarted.resolve();
                    await releaseFirstResponse.promise;
                    return {
                        content: [
                            {
                                text: `Loaded a large working context.\n\n${"context detail ".repeat(180)}`,
                                type: "text",
                            },
                        ],
                        usage: usage(400, 50),
                    };
                }
                if (callIndex === 1) {
                    expect(request.options.intent).toBe("compaction");
                    expect(request.context.tools).toEqual(firstInferenceContext?.tools);
                    expect(request.context.messages[0]).toMatchObject({
                        role: firstInferenceContext?.messages[0]?.role,
                        content: firstInferenceContext?.messages[0]?.content,
                    });
                    compactionStarted.resolve();
                    await releaseCompaction.promise;
                    return {
                        compactionContext: {
                            ...request.context,
                            messages: [
                                {
                                    role: "user",
                                    content: "The earlier context was summarized.",
                                    timestamp: 1,
                                },
                            ],
                        },
                        content: [],
                    };
                }
                expect(callIndex).toBe(2);
                expect(request.options.intent).not.toBe("compaction");
                return {
                    content: [{ text: "Continued with compacted context.", type: "text" }],
                    contextTokens: 130,
                    usage: usage(100, 30),
                };
            },
            rows: 26,
        });
        running.add(gym);

        submit(gym, "Load enough detail to fill the context.");
        await firstResponseStarted.promise;
        await gym.terminal.waitForText("Working", 30_000);
        gym.terminal.type("Continue from that work.");
        await gym.terminal.waitForText("› Continue from that work.", 30_000);
        gym.terminal.press("tab");
        await gym.terminal.waitForText("↳ queued Continue from that work.", 30_000);
        releaseFirstResponse.resolve();

        await compactionStarted.promise;
        const compacting = await gym.terminal.waitUntil(
            (candidate) =>
                /Compacting context · [\d.]+k? tokens \(\d+s · esc to interrupt\)/u.test(
                    candidate.text,
                ),
            "live compaction progress with token and elapsed-time counters",
            30_000,
        );
        expect(compacting.text).not.toContain("Context compacted");
        releaseCompaction.resolve();

        const snapshot = await gym.terminal.waitUntil(
            (candidate) =>
                candidate.text.includes("Context compacted") &&
                candidate.text.includes("Continued with compacted context.") &&
                candidate.scroll.atBottom,
            "a visible automatic compaction row",
            30_000,
        );
        expect(snapshot.text).toMatch(
            /Summarized \d+ older messages; [\d.]+k? → [\d.]+k? tokens\./u,
        );
        await captureReviewImage(snapshot, "automatic-compaction-visible.png");

        submit(gym, "/usage");
        const refreshed = await gym.terminal.waitUntil(
            (candidate) =>
                candidate.text.includes("Context: 130 / 500 · 74% left") &&
                candidate.text.includes("Session tokens: 580"),
            "authoritative context after compaction inference",
            30_000,
        );
        expect(refreshed.text).not.toContain("Context: ~130");
        await mkdir(usageArtifacts, { recursive: true });
        await renderTerminalSnapshotPng(
            refreshed,
            resolve(usageArtifacts, "post-compaction-context-refresh.png"),
        );
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function usage(input: number, output: number) {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: input + output,
    };
}

async function captureReviewImage(snapshot: TerminalSnapshot, fileName: string): Promise<void> {
    const directory = process.env.RIG_GYM_SCREENSHOT_DIR;
    if (directory === undefined) return;
    await renderTerminalSnapshotPng(snapshot, resolve(directory, fileName));
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
