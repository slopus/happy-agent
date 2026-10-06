import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigModule } from "@slopus/happy-agent-modules";
import { GlmProvider, KimiProvider } from "@slopus/happy-providers";

import {
    assertGymProviderEndpointAllowed,
    createGymInferenceFromEnvironment,
} from "../sources/lifecycle/gymInference.js";

describe("Gym inference boundaries", () => {
    it.each(["http://127.0.0.1:4111/v1", "http://localhost:4111", "http://[::1]:4111"])(
        "allows a scenario-owned loopback endpoint in a deterministic gym: %s",
        (endpoint) => {
            expect(() => assertGymProviderEndpointAllowed(endpoint, false)).not.toThrow();
        },
    );

    it("rejects an external endpoint without the live inference opt-in", () => {
        expect(() => assertGymProviderEndpointAllowed("https://api.example.com/v1", false)).toThrow(
            'Non-live Gym inference cannot use external provider endpoint "https://api.example.com/v1".',
        );
    });

    it("allows the gym proxy's reserved HTTP fixture domain", () => {
        expect(() =>
            assertGymProviderEndpointAllowed("http://bedrock.gym.test/openai/v1", false),
        ).not.toThrow();
        expect(() =>
            assertGymProviderEndpointAllowed("https://bedrock.gym.test/openai/v1", false),
        ).toThrow();
        expect(() =>
            assertGymProviderEndpointAllowed("http://bedrock.gym.test.example.com/v1", false),
        ).toThrow();
    });

    it("allows an external endpoint after the live inference opt-in", () => {
        expect(() =>
            assertGymProviderEndpointAllowed("https://api.example.com/v1", true),
        ).not.toThrow();
    });

    it.each([
        ["moonshotai/kimi-k3", KimiProvider],
        ["zai/glm-5.3", GlmProvider],
    ] as const)(
        "keeps the real Bedrock provider for an explicit scenario-owned %s endpoint",
        async (modelId, Provider) => {
            const root = await mkdtemp(join(tmpdir(), "happy-bedrock-gym-factory-"));
            try {
                const directory = join(
                    root,
                    process.platform === "darwin" ? "Happy/Config" : "happy/config",
                );
                await mkdir(directory, { recursive: true });
                await writeFile(
                    join(directory, "happy.toml"),
                    [
                        "[providers]",
                        "default_enable = false",
                        "[providers.bedrock]",
                        "enabled = true",
                        'bearer_token = "fixture-placeholder"',
                        `[providers.bedrock.model_overrides."${modelId}"]`,
                        'endpoint = "http://bedrock.gym.test/openai/v1"',
                    ].join("\n"),
                );
                const config = await ConfigModule.load(join(root, ".happy"));
                const factory = createGymInferenceFromEnvironment({
                    HAPPY_GYM_INFERENCE_URL: "http://localhost:1234",
                    HAPPY_GYM_TOKEN: "fixture",
                })!;
                const result = await factory(
                    { models: config.offeredModels, providers: config.providers },
                    config.configuration,
                );
                expect(await result.providers.resolve("bedrock", modelId)).toBeInstanceOf(Provider);
                expect(
                    (await result.providers.resolve("bedrock", "openai/gpt-5.4"))?.constructor.name,
                ).toBe("gym");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});
