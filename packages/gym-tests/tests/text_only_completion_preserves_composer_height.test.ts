import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("text-only completion preserves composer height", () => {
    it("hands the live activity row into immutable history without moving the composer", async () => {
        const gym = await createGym({
            cols: 72,
            inference: [
                {
                    completionDelayMs: 1_500,
                    content: [{ text: "TEXT_ONLY_HEIGHT_HANDOFF", type: "text" }],
                },
            ],
            rows: 16,
        });
        running.add(gym);

        gym.terminal.type("Answer with text only.");
        gym.terminal.press("enter");

        const active = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("TEXT_ONLY_HEIGHT_HANDOFF") &&
                snapshot.text.includes("esc to interrupt") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the streamed text with its live activity row",
            30_000,
        );
        const activeComposerRow = active.rows.findIndex((row) =>
            row.includes("Ask Happy Terminal to do anything"),
        );
        expect(activeComposerRow).toBeGreaterThan(0);

        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("TEXT_ONLY_HEIGHT_HANDOFF") &&
                snapshot.text.includes("gym off · /workspace") &&
                !snapshot.text.includes("esc to interrupt"),
            "the text-only response and idle composer",
            30_000,
        );
        const completedComposerRow = completed.rows.findIndex((row) =>
            row.includes("Ask Happy Terminal to do anything"),
        );
        const completedResponseRow = completed.rows.findIndex((row) =>
            row.includes("TEXT_ONLY_HEIGHT_HANDOFF"),
        );
        const workedRow = completed.rows.findIndex((row) => row.includes("Worked for"));

        expect(completedResponseRow).toBeLessThan(workedRow);
        expect(workedRow).toBeLessThan(completedComposerRow);
        expect(completed.text.match(/Worked for/gu)).toHaveLength(1);
        expect(completedComposerRow).toBe(activeComposerRow);
        expect(completed.scroll.atBottom).toBe(true);
        expect(completed.text).not.toContain("�");
    }, 60_000);
});
