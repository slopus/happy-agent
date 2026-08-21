import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("failed remote run service messages", () => {
    it("renders the daemon's failure instead of replacing it with a generic error", async () => {
        const gym = await createGym({
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: { access_token: "codex-token-without-an-account-id" },
                }),
                "happy/config/happy.toml": "[settings]\ninference_max_retries = 0\n",
            },
            inference: [],
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
        });
        running.add(gym);

        gym.terminal.type("Trigger the credential failure.");
        gym.terminal.press("enter");

        const failure = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Codex authentication is missing a ChatGPT account ID.") &&
                screen.text.includes("Ask Happy Terminal to do anything") &&
                !screen.text.includes("esc to interrupt"),
            "the daemon service failure to settle",
        );
        expect(failure.text).not.toContain("The remote run failed.");
    }, 30_000);
});
