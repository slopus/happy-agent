import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Codex command output policy", () => {
    it("clamps a larger per-call request before the next inference", async () => {
        const gym = await createGym({
            files: { "huge.log": "x".repeat(50_000) },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "cat huge.log",
                                    max_output_tokens: 40_000,
                                },
                                id: "large-command-output",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                const serialized = JSON.stringify(request.context.messages);
                expect(serialized).toContain("Original token count: 12500");
                expect(serialized).toContain(
                    "Warning: truncated output (original token count: 12500)",
                );
                expect(serialized.length).toBeLessThan(45_000);
                return { content: [{ text: "OUTPUT_POLICY_CLAMPED", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("Read the entire huge log in one command.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("OUTPUT_POLICY_CLAMPED", 30_000);
        expect(completed.text).toContain("OUTPUT_POLICY_CLAMPED");
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(2);
    }, 30_000);
});
