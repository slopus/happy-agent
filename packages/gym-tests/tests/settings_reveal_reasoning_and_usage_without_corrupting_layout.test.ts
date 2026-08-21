import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("settings reveal reasoning and usage without corrupting layout", () => {
    it("keeps hidden reasoning private, reports usage, then renders reasoning when enabled", async () => {
        const gym = await createGym({
            cols: 72,
            inference: [
                {
                    content: [
                        { thinking: "HIDDEN_REASONING_SENTINEL", type: "thinking" },
                        { text: "FIRST_COMPLETE", type: "text" },
                    ],
                    usage: {
                        cacheRead: 40,
                        cacheWrite: 30,
                        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                        input: 1_200,
                        output: 100,
                        totalTokens: 1_300,
                    },
                },
                {
                    content: [
                        { thinking: "VISIBLE_REASONING_SENTINEL", type: "thinking" },
                        { text: "SECOND_COMPLETE", type: "text" },
                    ],
                },
            ],
            rows: 24,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        gym.terminal.type("First turn.");
        gym.terminal.press("enter");
        const first = await gym.terminal.waitForText("FIRST_COMPLETE", 30_000);
        expect(first.text).not.toContain("HIDDEN_REASONING_SENTINEL");

        gym.terminal.type("/usage");
        gym.terminal.press("enter");
        const usage = await gym.terminal.waitForText("Session work: 1.3k used");
        expect(usage.text).toContain("Input: 1.2k");
        expect(usage.text).toContain("Output: 100");
        expect(usage.text).toContain("Cache read: 40");
        expect(usage.text).toContain("Cache write: 30");
        expect(usage.text).toContain("5-hour: unavailable");

        gym.terminal.type("/configure");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Show reasoning");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Reasoning display enabled.");

        gym.terminal.type("Second turn.");
        gym.terminal.press("enter");
        const second = await gym.terminal.waitForText("SECOND_COMPLETE", 30_000);
        expect(second.text).toContain("VISIBLE_REASONING_SENTINEL");
        expect(second.rows).toHaveLength(24);
        expect(second.scroll.atBottom).toBe(true);
        expect(second.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(second.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
        expect(second.text).not.toContain("�");
    });
});
