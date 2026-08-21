import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Escape during streamed assistant text", () => {
    it("keeps each rendered fragment once and before the durable interruption row", async () => {
        const firstFragment = "STREAMED_ESCAPE_ALPHA";
        const secondFragment = "STREAMED_ESCAPE_OMEGA";
        const gym = await createGym({
            cols: 72,
            inference: [
                {
                    completionDelayMs: 5_000,
                    content: [
                        {
                            text: `${firstFragment} remains visible. ${secondFragment}`,
                            type: "text",
                        },
                    ],
                },
            ],
            rows: 24,
        });
        running.add(gym);

        gym.terminal.type("Stream a response that I will interrupt.");
        gym.terminal.press("enter");

        const partial = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(firstFragment) &&
                snapshot.text.includes(secondFragment) &&
                snapshot.text.includes("esc to interrupt"),
            "both partial assistant fragments",
            30_000,
        );
        expect(countOccurrences(partial.text, firstFragment)).toBe(1);
        expect(countOccurrences(partial.text, secondFragment)).toBe(1);

        gym.terminal.press("escape");
        const interrupted = await gym.terminal.waitForText("Session interrupted", 30_000);
        const settled = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                !snapshot.text.includes("esc to interrupt"),
            "the interrupted stream to durably settle",
            30_000,
        );
        expect(settled.outputRevision).toBeGreaterThanOrEqual(interrupted.outputRevision);

        expect(countOccurrences(settled.text, firstFragment)).toBe(1);
        expect(countOccurrences(settled.text, secondFragment)).toBe(1);
        expect(countOccurrences(settled.text, "Session interrupted")).toBe(1);
        expect(settled.text.indexOf(firstFragment)).toBeLessThan(
            settled.text.indexOf("Session interrupted"),
        );
        expect(settled.text.indexOf(secondFragment)).toBeLessThan(
            settled.text.indexOf("Session interrupted"),
        );
        if (process.env.HAPPY_TERMINAL_GYM_PROOF_PATH !== undefined) {
            await gym.terminal.screenshot(process.env.HAPPY_TERMINAL_GYM_PROOF_PATH);
        }
    }, 90_000);
});

function countOccurrences(text: string, fragment: string): number {
    return text.split(fragment).length - 1;
}
