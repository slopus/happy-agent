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
                snapshot.text.includes("1k used · 10% cache hit · 1.1k context"),
            "the first cumulative token status",
            30_000,
        );
        expect(footer(first)).toContain("1k used · 10% cache hit · 1.1k context");

        submit(gym, "Record the second usage sample.");
        const second = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SECOND_USAGE_RECORDED") &&
                snapshot.text.includes("1.2k used · 50% cache hit · 1.1k context"),
            "the accumulated token status",
            30_000,
        );
        expect(footer(second)).toContain("1.2k used · 50% cache hit · 1.1k context");
    }, 120_000);

    it("replaces the footer with the attributed root and subagent subtree total", async () => {
        let parentSessionId: string | undefined;
        const gym = await createGym({
            homeFiles: { "Happy/Config/happy.toml": "[settings]\nshow_usage = true\n" },
            inference(request, callIndex) {
                parentSessionId ??= request.options.sessionId;
                if (
                    request.options.sessionId !== undefined &&
                    request.options.sessionId !== parentSessionId
                ) {
                    return {
                        content: [{ text: "CHILD_USAGE_RECORDED", type: "text" }],
                        usage: usage({ cacheRead: 250, input: 300, output: 30 }),
                    };
                }
                if (callIndex > 0) {
                    return {
                        content: [{ text: "PARENT_USAGE_RECORDED", type: "text" }],
                        usage: usage({ cacheRead: 150, input: 200, output: 20 }),
                    };
                }
                return {
                    content: [
                        {
                            arguments: {
                                effort: "medium",
                                model: "openai/gym",
                                text: "Record attributed child usage.",
                                title: "Usage child",
                            },
                            name: "create_agent",
                            type: "tool_call",
                        },
                    ],
                    usage: usage({ cacheRead: 50, input: 100, output: 10 }),
                };
            },
        });
        running.add(gym);

        submit(gym, "Delegate one attributed usage sample.");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PARENT_USAGE_RECORDED") &&
                snapshot.text.includes("280 used · 75% cache hit · 220 context"),
            "the authoritative root and subagent footer total",
            30_000,
        );
        expect(footer(completed)).toContain("280 used · 75% cache hit · 220 context");
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
