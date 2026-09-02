import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("named Claude OAuth-token accounts", () => {
    it("selects the configured account and completes a Claude turn", async () => {
        const responseMarker = "NAMED_CLAUDE_ACCOUNT_RESPONSE";
        const gym = await createGym({
            environment: {
                HAPPY_TERMINAL_PROVIDER: "work_claude",
            },
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[providers.claude]",
                    "enabled = false",
                    "",
                    "[providers.work_claude]",
                    "enabled = true",
                    'type = "claude"',
                    'oauth_token = "work-claude-oauth-token"',
                    "",
                ].join("\n"),
            },
            inference: [{ content: [{ text: responseMarker, type: "text" }] }],
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
        });
        running.add(gym);

        gym.terminal.type("Reply with the mocked response.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(responseMarker);
        expect(screen.text).toContain("Provider: Work Claude");
        expect(screen.text).toContain(responseMarker);

        const agentRequest = gym.inference.requests.find(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequest?.providerId).toBe("work_claude");
        expect(agentRequest?.modelId).toBe("anthropic/sonnet-5");
    });
});
