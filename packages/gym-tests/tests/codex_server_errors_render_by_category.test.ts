import { afterEach, describe, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Codex typed server errors", () => {
    it("renders internal failures and overloads distinctly", async () => {
        const gym = await createGym({
            cols: 160,
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token:
                            "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC10ZXN0In19.x",
                    },
                }),
            },
            inference: [
                {
                    content: [],
                    errorMessage: "An error occurred while processing your request.",
                    providerError: {
                        type: "internal_server_error",
                        diagnostics: {
                            requestId: "a22a6855-605a-4f23-9955-429f689b87c1",
                        },
                    },
                    stopReason: "error",
                },
                {
                    content: [],
                    errorMessage: "Our servers are currently overloaded.",
                    providerError: { type: "server_overloaded" },
                    stopReason: "error",
                },
            ],
            providerId: "codex",
            providerOverrides: ["codex"],
        });
        running.add(gym);

        await submitAndWait(
            gym,
            "Try Codex.",
            "Codex encountered an internal server error. Try again. Request ID: a22a6855-605a-4f23-9955-429f689b87c1.",
        );
        await submitAndWait(
            gym,
            "Try Codex again.",
            "Codex servers are overloaded. Try again later.",
        );
    });
});

async function submitAndWait(gym: Gym, prompt: string, expected: string): Promise<void> {
    gym.terminal.type(prompt);
    gym.terminal.press("enter");
    await gym.terminal.waitUntil(
        (screen) =>
            screen.text.includes(expected) &&
            screen.text.includes("Ask Rig to do anything") &&
            !screen.text.includes("esc to interrupt"),
        expected,
    );
}
