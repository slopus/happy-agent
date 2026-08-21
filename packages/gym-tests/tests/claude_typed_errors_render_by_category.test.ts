import { afterEach, describe, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Claude typed inference errors", () => {
    it("renders exhausted tokens, ordinary rate limits, and unclassified failures distinctly", async () => {
        const gym = await createGym({
            environment: {
                HAPPY_TERMINAL_GYM_PROVIDER_OVERRIDES: "kirill_claude",
                HAPPY_TERMINAL_PROVIDER: "kirill_claude",
            },
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[providers.claude]",
                    "enabled = false",
                    "",
                    "[providers.kirill_claude]",
                    'type = "claude"',
                    'oauth_token = "test-only-token"',
                    "",
                ].join("\n"),
            },
            inference: [
                {
                    content: [],
                    errorMessage: "Credit balance is too low",
                    providerError: { type: "out_of_tokens" },
                    stopReason: "error",
                },
                {
                    content: [],
                    errorMessage: "Rate limit exceeded",
                    providerError: { type: "rate_limit" },
                    stopReason: "error",
                },
                {
                    content: [],
                    errorMessage: "Anthropic's API is unavailable",
                    providerError: { type: "unclassified" },
                    stopReason: "error",
                },
            ],
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
        });
        running.add(gym);

        await submitAndWait(gym, "Use the paid Claude account.", "Kirill Claude is out of tokens.");
        await submitAndWait(gym, "Try Claude again.", "Kirill Claude is rate limited.");
        await submitAndWait(gym, "Try Claude once more.", "Anthropic's API is unavailable");
    });
});

async function submitAndWait(gym: Gym, prompt: string, expected: string): Promise<void> {
    gym.terminal.type(prompt);
    gym.terminal.press("enter");
    await gym.terminal.waitUntil(
        (screen) =>
            screen.text.includes(expected) &&
            screen.text.includes("Ask Happy Terminal to do anything") &&
            !screen.text.includes("esc to interrupt"),
        expected,
    );
}
