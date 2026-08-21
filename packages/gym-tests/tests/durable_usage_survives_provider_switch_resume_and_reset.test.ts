import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const artifacts = resolve(
    import.meta.dirname,
    "../../artifacts/integrated-critical-wave/clean-features",
);
const rig = "node /app/packages/rig/dist/main.js";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("durable session usage", () => {
    it("groups providers, resumes exactly once, increments, stays narrow, and resets", async () => {
        await mkdir(artifacts, { recursive: true });
        const gym = await createGym({
            cols: 58,
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            mode: "docker",
            entrypoint: [
                "bash",
                "-lc",
                `${rig}; echo SESSION_USAGE_RESUMED; exec ${rig} resume --last`,
            ],
            inference(_request, callIndex) {
                const turns = [
                    { input: 100, output: 10, text: "GYM_USAGE_TURN" },
                    { input: 200, output: 20, text: "CLAUDE_USAGE_TURN" },
                    { input: 300, output: 30, text: "RESUMED_USAGE_TURN" },
                ];
                const turn = turns[callIndex];
                if (turn === undefined) throw new Error(`Unexpected usage call ${callIndex}.`);
                return {
                    content: [{ text: turn.text, type: "text" }],
                    ...(callIndex === 1 ? { responseModel: "claude-fable-concrete" } : {}),
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                        input: turn.input,
                        output: turn.output,
                        totalTokens: turn.input + turn.output,
                    },
                };
            },
            providerOverrides: ["claude"],
            rows: 27,
        });
        running.add(gym);

        submit(gym, "Record Gym usage.");
        await gym.terminal.waitForText("GYM_USAGE_TURN", 30_000);

        submit(gym, "/model");
        await gym.terminal.waitForText("Choose Model");
        for (let index = 0; index < 6; index += 1) gym.terminal.press("down");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Choose Reasoning");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (screen) =>
                !screen.text.includes("Choose Reasoning") &&
                screen.text.includes("Ask Rig to do anything"),
            "Claude model selection",
            30_000,
        );

        submit(gym, "Record Claude usage.");
        await gym.terminal.waitForText("CLAUDE_USAGE_TURN", 30_000);
        submit(gym, "/usage");
        const switched = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Gym") &&
                screen.text.includes("Claude") &&
                screen.text.includes("Claude Fable Concrete") &&
                screen.text.includes("Session work: 330 used · 0% cache hit") &&
                screen.text.includes("5-hour: unavailable"),
            "multi-provider durable usage",
            30_000,
        );
        expect(switched.rows).toHaveLength(27);
        expect(switched.text).not.toContain("�");
        expect(switched.text).toContain("Input: 100");
        expect(switched.text).toContain("Output: 10");
        expect(switched.text).toContain("Input: 200");
        expect(switched.text).toContain("Output: 20");
        expect(switched.text).not.toContain("Usage Gym");
        expect(switched.rows.filter((row) => row.includes("└"))).toEqual(["  └ Gym"]);
        await gym.terminal.screenshot(`${artifacts}/multi-provider-narrow-unavailable.png`);

        gym.terminal.press("ctrlD");
        await gym.terminal.waitForText("SESSION_USAGE_RESUMED", 30_000);
        await gym.terminal.waitForText("Ask Rig to do anything", 30_000);
        submit(gym, "/usage");
        const resumed = await gym.terminal.waitForText("Session work: 330 used", 30_000);
        await gym.terminal.screenshot(`${artifacts}/resume-exactly-once.png`);
        expect(resumed.text).toContain("Claude Fable Concrete");

        submit(gym, "Increment after resume.");
        await gym.terminal.waitForText("RESUMED_USAGE_TURN", 30_000);
        submit(gym, "/usage");
        const incremented = await gym.terminal.waitForText("Session work: 660 used", 30_000);
        await gym.terminal.screenshot(`${artifacts}/resume-increment.png`);
        expect(incremented.text).toContain("Claude");

        submit(gym, "/new");
        await gym.terminal.waitForText("Session reset. Started a new session.", 30_000);
        submit(gym, "/usage");
        const reset = await gym.terminal.waitForText("Session work: 0 used", 30_000);
        expect(reset.text).not.toContain("Context: unavailable");
        await gym.terminal.screenshot(`${artifacts}/new-resets-usage.png`);
    }, 180_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
