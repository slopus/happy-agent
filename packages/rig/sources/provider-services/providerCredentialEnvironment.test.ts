import { describe, expect, it } from "vitest";

import { providerCredentialEnvironment } from "./providerCredentialEnvironment.js";

describe("providerCredentialEnvironment", () => {
    it("removes receiving-machine credentials only for an isolated provisioned provider", () => {
        const environment = {
            ANTHROPIC_API_KEY: "local-claude",
            OPENAI_API_KEY: "local-codex",
            SHELL: "/bin/zsh",
            XAI_API_KEY: "local-grok",
        };

        expect(
            providerCredentialEnvironment(
                {
                    apiKey: "remote-grok",
                    credentialIsolation: true,
                    enabled: true,
                    type: "grok",
                },
                environment,
            ),
        ).toEqual({ SHELL: "/bin/zsh" });
        expect(providerCredentialEnvironment({ enabled: true, type: "grok" }, environment)).toBe(
            environment,
        );
    });
});
