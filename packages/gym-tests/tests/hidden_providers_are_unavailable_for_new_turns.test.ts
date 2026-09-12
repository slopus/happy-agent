import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("hidden provider configuration", () => {
    it("runs two smart-provider turns through a hidden account without offering that account directly", async () => {
        const gym = await createGym({
            modelId: "openai/gpt-5.6-sol",
            environment: { HAPPY_TERMINAL_PROVIDER: "router" },
            homeFiles: {
                "happy/config/happy.toml": [
                    "[providers]",
                    "default_enable = false",
                    "[providers.codex]",
                    "enabled = true",
                    "hidden = true",
                    "credential_isolation = true",
                    "[providers.router]",
                    'type = "smart"',
                    'providers = ["codex"]',
                    "enabled = true",
                ].join("\n"),
            },
            inference(request, callIndex) {
                expect(request.providerId).toBe("codex");
                // Gym's synthetic runtime header names the concrete transport; the product's
                // selectable-model guidance must expose only the virtual provider.
                expect(request.context.systemPrompt).toContain("Provider ID: codex");
                expect(request.context.systemPrompt).toContain("provider ID: `router`");
                expect(request.context.systemPrompt).not.toContain("provider ID: `codex`");
                return {
                    content: [
                        { type: "text", text: `Hidden account routed turn ${callIndex + 1}.` },
                    ],
                };
            },
        });
        running.add(gym);
        for (let turn = 1; turn <= 2; turn += 1) {
            gym.terminal.type(`Run routed turn ${turn}.`);
            gym.terminal.press("enter");
            await gym.terminal.waitForText(`Hidden account routed turn ${turn}.`, 30_000);
        }
        expect(gym.inference.requests.some((request) => request.providerId === "codex")).toBe(true);
        expect(gym.inference.requests.some((request) => request.providerId === "router")).toBe(
            false,
        );
    });

    it("omits a hidden enabled provider from model selection and inference guidance", async () => {
        const gym = await createGym({
            providerId: "codex",
            modelId: "openai/gpt-5.6-sol",
            homeFiles: {
                "happy/config/happy.toml": [
                    "[providers]",
                    "default_enable = false",
                    "[providers.codex]",
                    "enabled = true",
                    "[providers.claude]",
                    "enabled = true",
                    "hidden = true",
                ].join("\n"),
            },
            inference(request, callIndex) {
                expect(request.providerId).toBe("codex");
                expect(request.context.systemPrompt).toContain("provider ID: `codex`");
                expect(request.context.systemPrompt).not.toContain("provider ID: `claude`");
                return {
                    content: [
                        { text: `Visible provider response ${callIndex + 1}.`, type: "text" },
                    ],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const menu = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(menu.text).toContain("GPT-5.6 Sol");
        expect(menu.text).not.toContain("Sonnet 5");
        expect(menu.text).not.toContain("Opus 5");
        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

        for (let turn = 1; turn <= 2; turn += 1) {
            gym.terminal.type(`Run visible provider turn ${turn}.`);
            gym.terminal.press("enter");
            await gym.terminal.waitForText(`Visible provider response ${turn}.`, 30_000);
        }
        expect(gym.inference.requests.every((request) => request.providerId !== "claude")).toBe(
            true,
        );
    });
});
