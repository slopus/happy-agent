import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("completed turn usage summary", () => {
    it("keeps each completed turn showing the totals it finished with", async () => {
        const gym = await createGym({
            homeFiles: { "Happy/Config/happy.toml": "[settings]\nshow_usage = true\n" },
            inference: [
                {
                    content: [{ text: "FIRST_TURN_DONE", type: "text" }],
                    usage: usage({ cacheRead: 100, input: 1_000, output: 300 }),
                },
                {
                    content: [{ text: "SECOND_TURN_DONE", type: "text" }],
                    usage: usage({ cacheRead: 900, input: 1_000, output: 300 }),
                },
            ],
        });
        running.add(gym);

        submit(gym, "Finish the first turn.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("FIRST_TURN_DONE") &&
                snapshot.text.includes("300 generated · 10% cache hit"),
            "the first completed turn usage summary",
            30_000,
        );

        submit(gym, "Finish the second turn.");
        const second = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SECOND_TURN_DONE") &&
                snapshot.text.includes("600 generated · 50% cache hit"),
            "the second completed turn usage summary",
            30_000,
        );

        expect(second.text).toContain("300 generated · 10% cache hit");
        expect(second.text).toContain("600 generated · 50% cache hit");
    }, 120_000);

    it("omits the usage summary under the default setting", async () => {
        const gym = await createGym({
            inference: [
                {
                    content: [{ text: "QUIET_TURN_DONE", type: "text" }],
                    usage: usage({ cacheRead: 100, input: 1_000, output: 300 }),
                },
            ],
        });
        running.add(gym);

        submit(gym, "Finish a turn without token status.");
        const completed = await gym.terminal.waitForText("QUIET_TURN_DONE", 30_000);
        expect(completed.text).not.toContain("generated");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function usage(values: { cacheRead: number; input: number; output: number }): {
    cacheRead: number;
    cacheWrite: number;
    cost: { cacheRead: number; cacheWrite: number; input: number; output: number; total: number };
    input: number;
    output: number;
    totalTokens: number;
} {
    return {
        cacheRead: values.cacheRead,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: values.input,
        output: values.output,
        totalTokens: values.input + values.output,
    };
}
