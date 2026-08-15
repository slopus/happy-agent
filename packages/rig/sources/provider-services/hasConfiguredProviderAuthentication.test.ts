import { describe, expect, it } from "vitest";

import { hasConfiguredProviderAuthentication } from "./hasConfiguredProviderAuthentication.js";

describe("hasConfiguredProviderAuthentication", () => {
    it.each([
        {
            config: {
                apiKey: "provisioned-codex-key",
                baseUrl: "https://example.test/codex",
                enabled: true,
                type: "codex" as const,
            },
        },
        {
            config: { apiKey: "provisioned-claude-key", enabled: true, type: "claude" as const },
        },
        {
            config: {
                authToken: "provisioned-claude-token",
                enabled: true,
                type: "claude" as const,
            },
        },
        {
            config: { apiKey: "provisioned-grok-key", enabled: true, type: "grok" as const },
        },
    ])("recognizes the configured imported credential", async ({ config }) => {
        await expect(hasConfiguredProviderAuthentication({ config, env: {} })).resolves.toBe(true);
    });
});
