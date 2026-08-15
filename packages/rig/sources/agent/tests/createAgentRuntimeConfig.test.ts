import { describe, expect, it } from "vitest";

import type { ConfigProviders } from "../../config/types.js";
import type { ModelCatalog } from "../../protocol/index.js";
import { createAgentRuntimeConfig } from "../createAgentRuntimeConfig.js";

describe("createAgentRuntimeConfig", () => {
    it("builds the Agent Base catalog directly from enabled configured providers", () => {
        const providers: ConfigProviders = {
            primary: {
                apiKey: "test-key",
                enabled: true,
                type: "codex",
            },
            disabled: {
                apiKey: "unused",
                enabled: false,
                type: "grok",
            },
        };
        const catalog: ModelCatalog = {
            defaultModelId: "gpt-test",
            defaultProviderId: "primary",
            models: [],
            providers: [
                {
                    models: [
                        {
                            defaultThinkingLevel: "ultra",
                            id: "gpt-test",
                            name: "GPT Test",
                            thinkingLevels: ["off", "medium", "ultra"],
                        },
                    ],
                    providerId: "primary",
                    providerType: "codex",
                    serviceTiers: ["fast"],
                },
                {
                    models: [
                        {
                            defaultThinkingLevel: "on",
                            id: "grok-test",
                            name: "Grok Test",
                            thinkingLevels: ["on"],
                        },
                    ],
                    providerId: "disabled",
                    providerType: "grok",
                },
            ],
        };

        const runtime = createAgentRuntimeConfig({
            catalog,
            env: {},
            providers,
        });

        expect(runtime.defaultProvider).toBe("primary");
        expect(runtime.providers.ids).toEqual(["primary"]);
        expect(runtime.models).toEqual([
            {
                defaultEffort: "max",
                effortLevels: ["off", "medium", "max"],
                id: "gpt-test",
                name: "GPT Test",
                providerId: "primary",
                serviceTiers: ["priority"],
            },
        ]);
    });

    it("registers every configured provider with the model-family kind used by prompts", () => {
        const model = (id: string) => ({
            defaultThinkingLevel: "medium",
            id,
            name: id,
            thinkingLevels: ["medium"],
        });
        const runtime = createAgentRuntimeConfig({
            catalog: {
                defaultModelId: "openai/gym",
                defaultProviderId: "gym",
                models: [],
                providers: [
                    { models: [model("openai/gym")], providerId: "gym" },
                    { models: [model("anthropic/opus-5")], providerId: "work_bedrock" },
                    { models: [model("anthropic/sonnet-5")], providerId: "work_claude" },
                    { models: [model("openai/gpt-5.6-sol")], providerId: "work_codex" },
                    { models: [model("xai/grok-4.5")], providerId: "work_grok" },
                ],
            },
            env: { RIG_GYM_INFERENCE_URL: "https://gym.test/inference" },
            providers: {
                work_bedrock: { enabled: true, type: "bedrock" },
                work_claude: { enabled: true, type: "claude" },
                work_codex: { enabled: true, type: "codex" },
                work_grok: { enabled: true, type: "grok" },
            },
        });

        expect(
            Object.fromEntries(
                runtime.providers.ids.map((id) => [id, runtime.providers.typeOf(id)]),
            ),
        ).toEqual({
            gym: "codex",
            work_bedrock: "bedrock",
            work_claude: "claude",
            work_codex: "codex",
            work_grok: "grok",
        });
    });
});
