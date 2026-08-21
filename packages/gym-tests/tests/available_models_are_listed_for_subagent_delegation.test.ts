import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("available model guidance", () => {
    it("tells the agent which configured models it can run as subagents", async () => {
        const gym = await createGym({
            inference(request) {
                const systemPrompt = request.context.systemPrompt;
                expect(systemPrompt).toContain("## Available models");
                expect(systemPrompt).toContain(
                    "- Sonnet 5 — model ID: `anthropic/sonnet-5`; provider ID: `claude`",
                );
                expect(systemPrompt).toContain(
                    "- Opus 5 1M — model ID: `anthropic/opus-5`; provider ID: `claude`",
                );
                expect(systemPrompt).toContain(
                    "- Opus 4.8 1M — model ID: `anthropic/opus-4-8`; provider ID: `claude`",
                );
                expect(systemPrompt).toContain(
                    "- GPT-5.6 Sol — model ID: `openai/gpt-5.6-sol`; provider ID: `codex`",
                );
                return { content: [{ text: "MODEL_GUIDANCE_OK", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const modelMenu = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(modelMenu.text).toContain("Opus 5 1M");
        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

        gym.terminal.type("Confirm the available model guidance.");
        gym.terminal.press("enter");

        const result = await gym.terminal.waitForText("MODEL_GUIDANCE_OK", 30_000);
        expect(result.text).toContain("MODEL_GUIDANCE_OK");
    });

    it("keeps providers disabled by the provider default out of the picker and prompt", async () => {
        const gym = await createGym({
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[providers]",
                    "default_enable = false",
                    "",
                    "[providers.codex]",
                    "enabled = true",
                ].join("\n"),
            },
            inference(request) {
                const systemPrompt = request.context.systemPrompt;
                expect(systemPrompt).toContain(
                    "# Runtime model\nModel ID: openai/gym\nProvider ID: gym",
                );
                expect(systemPrompt).toContain(
                    "- GPT-5.6 Sol — model ID: `openai/gpt-5.6-sol`; provider ID: `codex`",
                );
                expect(systemPrompt).not.toContain("Sonnet 5");
                expect(systemPrompt).not.toContain("Grok Build");
                expect(systemPrompt).not.toContain("Grok 4.5");
                expect(systemPrompt).not.toContain("Composer 2.5");
                return { content: [{ text: "FILTERED_MODEL_GUIDANCE_OK", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const modelMenu = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(modelMenu.text).toContain("GPT-5.6 Sol");
        expect(modelMenu.text).not.toContain("Grok Build");
        expect(modelMenu.text).not.toContain("Grok 4.5");
        expect(modelMenu.text).not.toContain("Composer 2.5");
        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

        gym.terminal.type("Confirm disabled provider models are hidden.");
        gym.terminal.press("enter");

        const result = await gym.terminal.waitForText("FILTERED_MODEL_GUIDANCE_OK", 30_000);
        expect(result.text).toContain("FILTERED_MODEL_GUIDANCE_OK");
    });

    it("tells a model its concrete model and provider IDs", async () => {
        const gym = await createGym({
            environment: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-test-token",
            },
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[providers]",
                    "default_enable = false",
                    "",
                    "[providers.bedrock]",
                    "enabled = true",
                ].join("\n"),
            },
            inference(request) {
                expect(request.context.systemPrompt).toContain(
                    "# Runtime model\nModel ID: openai/gpt-5.6-sol\nProvider ID: bedrock",
                );
                return { content: [{ text: "BEDROCK_ROUTE_OK", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "bedrock",
        });
        running.add(gym);

        gym.terminal.type("Confirm the inference provider route.");
        gym.terminal.press("enter");

        const result = await gym.terminal.waitForText("BEDROCK_ROUTE_OK", 30_000);
        expect(result.text).toContain("BEDROCK_ROUTE_OK");
    });
});
