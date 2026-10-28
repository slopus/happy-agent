import { describe, expect, it } from "vitest";

import { envKeyRoutes } from "../../sources/providerRoutes/impl/envKeyRoutes.js";

/** Fake keys only: the test never reads the environment of the computer running it. */
function machine(env: Record<string, string>) {
    return { platform: process.platform, env, programDirectories: [] };
}

const always = () => true;

describe("API keys in the daemon's environment", () => {
    it("flags an Anthropic key that quietly replaces a ready Claude Code sign-in", () => {
        const routes = envKeyRoutes(
            machine({ ANTHROPIC_API_KEY: "sk-ant-fake", OPENAI_API_KEY: "sk-fake" }),
            always,
            always,
        );
        expect(routes).toEqual([
            {
                id: "env:ANTHROPIC_API_KEY",
                kind: "api_key",
                name: "Anthropic API key",
                vendors: ["Anthropic"],
                billing: "pay_per_token",
                account: null,
                endpoint: null,
                status: "ready",
                models: null,
                warning:
                    "ANTHROPIC_API_KEY is set, so Anthropic is billed per token through this key instead of your Claude Code sign-in.",
                providerId: "claude",
            },
            // A ChatGPT sign-in outranks the key, so nothing changes quietly.
            expect.objectContaining({
                id: "env:OPENAI_API_KEY",
                billing: "pay_per_token",
                warning: null,
                providerId: "codex",
            }),
        ]);
        expect(JSON.stringify(routes)).not.toContain("fake");
    });

    it("warns about nothing when no sign-in is replaced, and ties no provider to an unused key", () => {
        const signedOut = envKeyRoutes(machine({ XAI_API_KEY: "xai-fake" }), always, () => false);
        expect(signedOut[0]).toMatchObject({ warning: null, providerId: "grok" });

        // The provider's configuration names its own key, so the environment's is unused.
        const configured = envKeyRoutes(machine({ XAI_API_KEY: "xai-fake" }), () => false, always);
        expect(configured[0]).toMatchObject({ warning: null });
        expect(configured[0]).not.toHaveProperty("providerId");

        // Claude reads CLAUDE_CODE_OAUTH_TOKEN first, so the API key beside it is unused.
        const both = envKeyRoutes(
            machine({ ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "t" }),
            always,
            always,
        );
        expect(both.map((route) => [route.id, route.billing, route.providerId])).toEqual([
            ["env:CLAUDE_CODE_OAUTH_TOKEN", "subscription", "claude"],
            ["env:ANTHROPIC_API_KEY", "pay_per_token", undefined],
        ]);
    });

    it("adds an OpenAI-compatible vendor by the variable's name, and only shows one without a catalog", () => {
        const routes = envKeyRoutes(
            machine({
                OPENROUTER_API_KEY: "sk-or-fake",
                GROQ_API_KEY: "gsk-fake",
                MISTRAL_API_KEY: " ",
            }),
            always,
            always,
        );
        expect(routes).toEqual([
            expect.objectContaining({
                id: "env:OPENROUTER_API_KEY",
                name: "OpenRouter API key",
                vendors: ["OpenRouter"],
                models: [
                    { id: "openai/gpt-6.1-terra", vendor: "OpenRouter" },
                    { id: "deepseek/deepseek-v4.1-flash-1017", vendor: "OpenRouter" },
                ],
                provider: {
                    id: "openrouter",
                    table: {
                        type: "openai_compatible",
                        name: "OpenRouter",
                        base_url: "https://openrouter.ai/api/v1",
                        api_key_env: "OPENROUTER_API_KEY",
                        models: ["openai/gpt-6.1-terra", "deepseek/deepseek-v4.1-flash-1017"],
                        reasoning_field: "reasoning",
                    },
                    summary: "Adds OpenRouter with the key in OPENROUTER_API_KEY.",
                },
            }),
            expect.objectContaining({ id: "env:GROQ_API_KEY", models: null }),
        ]);
        expect(routes[1]).not.toHaveProperty("provider");
    });
});
