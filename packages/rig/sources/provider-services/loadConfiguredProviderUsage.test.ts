import { describe, expect, it } from "vitest";

import { loadConfiguredProviderUsage } from "./loadConfiguredProviderUsage.js";

describe("loadConfiguredProviderUsage", () => {
    it.each([
        {
            id: "codex",
            provider: {
                apiKey: "provisioned-codex-key",
                enabled: true,
                type: "codex" as const,
            },
        },
        {
            id: "claude",
            provider: {
                apiKey: "provisioned-claude-key",
                enabled: true,
                type: "claude" as const,
            },
        },
        {
            id: "grok",
            provider: {
                apiKey: "provisioned-grok-key",
                enabled: true,
                type: "grok" as const,
            },
        },
    ])(
        "does not read a local account's usage for an imported $id API key",
        async ({ id, provider }) => {
            await expect(
                loadConfiguredProviderUsage({
                    env: {},
                    providerId: id,
                    providers: { [id]: provider },
                }),
            ).resolves.toBeNull();
        },
    );
});
