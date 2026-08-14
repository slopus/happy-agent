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
});
