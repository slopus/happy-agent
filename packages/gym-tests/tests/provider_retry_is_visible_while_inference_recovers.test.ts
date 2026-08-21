import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const RESPONSE_MARKER = "CLAUDE_RETRY_RECOVERED";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("provider retry status", () => {
    it("shows a provider retry while inference recovers", async () => {
        const gym = await createGym({
            cols: 140,
            inference: [
                {
                    content: [{ type: "text", text: RESPONSE_MARKER }],
                    providerRetries: [
                        {
                            attempt: 2,
                            delayMs: 2_000,
                            reason: "Claude API overloaded (HTTP 529); retrying in 2 s, attempt 2 of 10.",
                        },
                    ],
                },
            ],
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type("Recover from the scripted provider overload.");
        gym.terminal.press("enter");

        const retrying = await gym.terminal.waitForText("Claude API overloaded (HTTP 529)", 30_000);
        expect(retrying.text).toContain("Retrying");
        expect(retrying.text).toContain("attempt");

        const recovered = await gym.terminal.waitForText(RESPONSE_MARKER, 30_000);
        expect(recovered.text).toContain(RESPONSE_MARKER);
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(1);
    }, 120_000);
});
