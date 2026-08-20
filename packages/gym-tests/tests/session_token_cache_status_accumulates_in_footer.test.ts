import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("session token and cache status", () => {
    it("remains hidden under the default setting", async () => {
        const gym = await createGym({
            inference: [
                {
                    content: [{ text: "DEFAULT_USAGE_RECORDED", type: "text" }],
                    usage: usage({ cacheRead: 100, input: 1_000, output: 100 }),
                },
            ],
        });
        running.add(gym);

        submit(gym, "Record usage without enabling token status.");
        const completed = await gym.terminal.waitForText("DEFAULT_USAGE_RECORDED", 30_000);
        expect(footer(completed)).not.toContain("tokens");
        expect(footer(completed)).not.toContain("cache hit");
    }, 120_000);

    it("counts growing session context once while weighting cache hits across requests", async () => {
        const gym = await createGym({
            homeFiles: { "Happy/Config/happy.toml": "[settings]\nshow_usage = true\n" },
            inference: [
                {
                    content: [{ text: "FIRST_USAGE_RECORDED", type: "text" }],
                    usage: usage({ cacheRead: 100, input: 1_000, output: 100 }),
                },
                {
                    content: [{ text: "SECOND_USAGE_RECORDED", type: "text" }],
                    usage: usage({ cacheRead: 900, input: 1_000, output: 100 }),
                },
            ],
        });
        running.add(gym);

        submit(gym, "Record the first usage sample.");
        const first = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("FIRST_USAGE_RECORDED") &&
                snapshot.text.includes("1.1k tokens · 10% cache hit"),
            "the first cumulative token status",
            30_000,
        );
        expect(footer(first)).toContain("1.1k tokens · 10% cache hit");

        submit(gym, "Record the second usage sample.");
        const second = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SECOND_USAGE_RECORDED") &&
                snapshot.text.includes("1.1k tokens · 50% cache hit"),
            "the accumulated token status",
            30_000,
        );
        expect(footer(second)).toContain("1.1k tokens · 50% cache hit");
    }, 120_000);
});

function footer(snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>): string {
    return snapshot.rows.find((row) => row.includes("full access")) ?? "";
}

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
