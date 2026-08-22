import { describe, expect, it } from "vitest";

import { areProviderModelsCompatible } from "@/core/ProviderModelCompatibility.js";

describe("provider model compatibility", () => {
    it.each([
        ["codex", "openai/sol", "codex", "openai/terra", true],
        ["claude", "anthropic/opus", "bedrock", "anthropic/sonnet", false],
        ["bedrock", "anthropic/opus", "claude", "anthropic/sonnet", false],
        ["bedrock", "openai/sol", "bedrock", "openai/terra", true],
        ["codex", "openai/sol", "bedrock", "openai/terra", false],
        ["grok", "xai/build", "grok", "xai/composer", true],
        ["claude", "anthropic/opus", "claude", "openai/sol", false],
    ] as const)(
        "checks %s/%s against %s/%s",
        (leftType, leftModel, rightType, rightModel, expected) => {
            expect(
                areProviderModelsCompatible(
                    { modelId: leftModel, providerId: leftType, providerType: leftType },
                    { modelId: rightModel, providerId: rightType, providerType: rightType },
                ),
            ).toBe(expected);
        },
    );

    it.each([
        ["codex", "openai/sol", "openai/terra"],
        ["claude", "anthropic/opus", "anthropic/sonnet"],
        ["grok", "xai/build", "xai/composer"],
    ] as const)(
        "shares %s history between named accounts",
        (providerType, leftModel, rightModel) => {
            expect(
                areProviderModelsCompatible(
                    { modelId: leftModel, providerId: "personal", providerType },
                    { modelId: rightModel, providerId: "work", providerType },
                ),
            ).toBe(true);
        },
    );

    it("shares non-GPT Bedrock history between Bedrock accounts", () => {
        expect(
            areProviderModelsCompatible(
                {
                    modelId: "anthropic/opus",
                    providerId: "bedrock-us",
                    providerRegion: "us-east-1",
                    providerType: "bedrock",
                },
                {
                    modelId: "anthropic/sonnet",
                    providerId: "bedrock-eu",
                    providerRegion: "eu-west-1",
                    providerType: "bedrock",
                },
            ),
        ).toBe(true);
    });

    it("keeps Bedrock GPT history inside its region", () => {
        expect(
            areProviderModelsCompatible(
                {
                    modelId: "openai/sol",
                    providerId: "personal",
                    providerRegion: "us-east-1",
                    providerType: "bedrock",
                },
                {
                    modelId: "openai/terra",
                    providerId: "work",
                    providerRegion: "us-east-1",
                    providerType: "bedrock",
                },
            ),
        ).toBe(true);
        expect(
            areProviderModelsCompatible(
                {
                    modelId: "openai/sol",
                    providerId: "personal",
                    providerRegion: "us-east-1",
                    providerType: "bedrock",
                },
                {
                    modelId: "openai/terra",
                    providerId: "work",
                    providerRegion: "eu-west-1",
                    providerType: "bedrock",
                },
            ),
        ).toBe(false);
    });

    it("fails closed when a Bedrock GPT region is unavailable", () => {
        expect(
            areProviderModelsCompatible(
                { modelId: "openai/sol", providerId: "personal", providerType: "bedrock" },
                { modelId: "openai/terra", providerId: "work", providerType: "bedrock" },
            ),
        ).toBe(false);
        expect(
            areProviderModelsCompatible(
                {
                    modelId: "openai/sol",
                    providerId: "personal",
                    providerRegion: " ",
                    providerType: "bedrock",
                },
                { modelId: "openai/terra", providerId: "personal", providerType: "bedrock" },
            ),
        ).toBe(true);
    });
});
