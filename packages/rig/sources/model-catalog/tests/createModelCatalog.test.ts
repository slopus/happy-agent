import { describe, expect, it } from "vitest";

import { knownModels, type Model } from "@slopus/happy-agent-base";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    createModelCatalog as createModelCatalogWithContext,
    type CreateModelCatalogOptions,
} from "../createModelCatalog.js";

const createModelCatalog = (options?: CreateModelCatalogOptions) =>
    createModelCatalogWithContext(createTestRootContext().named("model-catalog"), options);
const knownModel = (id: string): Model => {
    const model = knownModels.find((candidate) => candidate.id === id);
    if (model === undefined) throw new Error(`Missing test model '${id}'.`);
    return model;
};
const modelAnthropicFable5 = knownModel("anthropic/fable-5");
const modelAnthropicOpus5 = knownModel("anthropic/opus-5");
const modelOpenaiCodexAutoReview = knownModel("openai/codex-auto-review");
const modelOpenaiGpt54 = knownModel("openai/gpt-5.4");
const modelOpenaiGpt56Luna = knownModel("openai/gpt-5.6-luna");
const modelOpenaiGpt56Sol = knownModel("openai/gpt-5.6-sol");
const modelOpenaiGpt56Terra = knownModel("openai/gpt-5.6-terra");
const modelXaiGrok45 = knownModel("xai/grok-4.5");
const modelXaiGrokBuild = knownModel("xai/grok-build");
const modelXaiGrokComposer25Fast = knownModel("xai/grok-composer-2.5-fast");

describe("createModelCatalog", () => {
    it("keeps Amazon Bedrock disabled without exposing models when its token is absent", () => {
        const catalog = createModelCatalog({ env: {} });

        expect(catalog.providers.find((provider) => provider.providerId === "bedrock")).toEqual({
            disabledReason: "not_authenticated",
            models: [],
            providerId: "bedrock",
            providerType: "bedrock",
        });
        expect(
            catalog.providers.find((provider) => provider.providerId === "codex")?.serviceTiers,
        ).toEqual(["fast"]);
        expect(
            catalog.providers.find((provider) => provider.providerId === "codex")?.providerType,
        ).toBe("codex");
        expect(
            catalog.providers.find((provider) => provider.providerId === "claude")?.providerType,
        ).toBe("claude");
        expect(
            catalog.providers.find((provider) => provider.providerId === "grok")?.providerType,
        ).toBe("grok");
        expect(
            catalog.providers.find((provider) => provider.providerId === "claude")?.serviceTiers,
        ).toBeUndefined();
        expect(
            catalog.providers.find((provider) => provider.providerId === "claude")?.models,
        ).toContain(modelAnthropicOpus5);
        expect(
            catalog.providers.find((provider) => provider.providerId === "grok")?.models,
        ).toEqual([modelXaiGrokBuild, modelXaiGrok45, modelXaiGrokComposer25Fast]);
    });

    it("enables Amazon Bedrock when its bearer token is present", () => {
        const catalog = createModelCatalog({
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
        });

        const codex = catalog.providers.find((provider) => provider.providerId === "codex");
        const bedrock = catalog.providers.find((provider) => provider.providerId === "bedrock");
        expect(catalog.defaultProviderId).toBe("codex");
        expect(catalog.defaultModelId).toBe(modelOpenaiGpt56Sol.id);
        expect(codex?.models).toContain(modelOpenaiGpt56Sol);
        expect(codex?.models.map((model) => model.id)).toEqual([
            modelOpenaiGpt56Sol.id,
            modelOpenaiGpt56Terra.id,
            modelOpenaiGpt56Luna.id,
        ]);
        expect(bedrock?.models.map((model) => model.id)).toEqual(
            expect.arrayContaining([
                modelOpenaiGpt56Sol.id,
                modelOpenaiGpt56Terra.id,
                modelOpenaiGpt56Luna.id,
            ]),
        );
        expect(bedrock?.providerType).toBe("bedrock");
        expect(bedrock?.serviceTiers).toBeUndefined();
        expect(catalog.models.filter((model) => model.id === modelOpenaiGpt56Sol.id)).toEqual([
            expect.objectContaining({
                contextWindow: 272_000,
                id: modelOpenaiGpt56Sol.id,
                thinkingLevels: expect.not.arrayContaining(["ultra"]),
            }),
        ]);
    });

    it("never offers the permission review models for selection", () => {
        const catalog = createModelCatalog({
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
        });

        const offeredIds = [
            ...catalog.models.map((model) => model.id),
            ...catalog.providers.flatMap((provider) => provider.models.map((model) => model.id)),
        ];
        expect(offeredIds).not.toContain(modelOpenaiCodexAutoReview.id);
        expect(offeredIds).not.toContain(modelOpenaiGpt54.id);
    });

    it("treats a blank bearer token as absent", () => {
        const catalog = createModelCatalog({
            env: { AWS_BEARER_TOKEN_BEDROCK: "   " },
        });

        expect(catalog.providers.find((provider) => provider.providerId === "bedrock")).toEqual({
            disabledReason: "not_authenticated",
            models: [],
            providerId: "bedrock",
            providerType: "bedrock",
        });
    });

    it("can expose Bedrock without native Codex or Claude Code authentication", () => {
        const catalog = createModelCatalog({
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
            providers: {
                bedrock: { enabled: true, type: "bedrock" },
                claude: { enabled: false, type: "claude" },
                codex: { enabled: false, type: "codex" },
            },
        });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "bedrock",
            "claude",
            "codex",
        ]);
        expect(catalog.providers.slice(1)).toEqual([
            {
                disabledReason: "not_enabled",
                models: [],
                providerId: "claude",
                providerType: "claude",
            },
            {
                disabledReason: "not_enabled",
                models: [],
                providerId: "codex",
                providerType: "codex",
            },
        ]);
        expect(catalog.defaultProviderId).toBe("bedrock");
        expect(catalog.defaultModelId).toBe(modelOpenaiGpt56Sol.id);
        expect(
            catalog.providers[0]?.models.find((model) => model.id === modelOpenaiGpt56Sol.id),
        ).toMatchObject({
            contextWindow: 272_000,
            thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        });
    });

    it("can hide Bedrock even when its credential is present", () => {
        const catalog = createModelCatalog({
            env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-token" },
            providers: {
                codex: { enabled: true, type: "codex" },
                claude: { enabled: true, type: "claude" },
                bedrock: { enabled: false, type: "bedrock" },
            },
        });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            "claude",
            "bedrock",
        ]);
        expect(catalog.providers[2]).toEqual({
            disabledReason: "not_enabled",
            models: [],
            providerId: "bedrock",
            providerType: "bedrock",
        });
    });

    it("supports multiple named Codex and Claude Code accounts with model filters", () => {
        const catalog = createModelCatalog({
            env: {},
            providers: {
                codex: { enabled: true, type: "codex" },
                work_codex: {
                    authFile: "/tmp/codex-work-auth.json",
                    enabled: true,
                    excludeModels: [modelOpenaiGpt56Luna.id],
                    includeModels: [modelOpenaiGpt56Sol.id, modelOpenaiGpt56Luna.id],
                    type: "codex",
                },
                claude: { enabled: true, type: "claude" },
                work_claude: {
                    configDir: "/tmp/claude-work",
                    enabled: true,
                    includeModels: [modelAnthropicFable5.id],
                    type: "claude",
                },
            },
        });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            "work_codex",
            "claude",
            "work_claude",
        ]);
        expect(
            catalog.providers.find((provider) => provider.providerId === "work_codex")?.models,
        ).toEqual([modelOpenaiGpt56Sol]);
        expect(
            catalog.providers.find((provider) => provider.providerId === "work_claude")?.models,
        ).toEqual([modelAnthropicFable5]);
    });

    it("uses custom Bedrock credential variables, regions, and model filters", () => {
        const catalog = createModelCatalog({
            env: { WORK_BEDROCK_TOKEN: "work-token" },
            providers: {
                west_bedrock: {
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                    enabled: true,
                    includeModels: [modelOpenaiGpt56Sol.id, modelOpenaiGpt56Luna.id],
                    modelOverrides: {
                        [modelOpenaiGpt56Sol.id]: {
                            endpoint: "https://mantle.example/openai/v1",
                        },
                        [modelOpenaiGpt56Luna.id]: { region: "us-east-1" },
                    },
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(catalog.providers[0]).toMatchObject({
            models: expect.arrayContaining([
                expect.objectContaining({ id: modelOpenaiGpt56Sol.id }),
                expect.objectContaining({ id: modelOpenaiGpt56Luna.id }),
            ]),
            providerId: "west_bedrock",
            providerType: "bedrock",
        });
    });

    it("skips a provider whose configured models are unavailable without hiding others", () => {
        const catalog = createModelCatalog({
            env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-token" },
            providers: {
                codex: { enabled: true, type: "codex" },
                west_bedrock: {
                    enabled: true,
                    includeModels: [modelOpenaiGpt56Sol.id],
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            "west_bedrock",
        ]);
        expect(catalog.providers[1]).toEqual({
            disabledReason: "no_models",
            models: [],
            providerId: "west_bedrock",
            providerType: "bedrock",
        });
    });

    it("represents empty model filters when no other provider is available", () => {
        expect(
            createModelCatalog({
                env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-token" },
                providers: {
                    west_bedrock: {
                        enabled: true,
                        includeModels: [modelOpenaiGpt56Sol.id],
                        region: "us-west-2",
                        type: "bedrock",
                    },
                },
            }),
        ).toEqual({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [
                {
                    disabledReason: "no_models",
                    models: [],
                    providerId: "west_bedrock",
                    providerType: "bedrock",
                },
            ],
        });
    });

    it("represents every configured provider when none is available", () => {
        expect(
            createModelCatalog({
                env: {},
                providers: {
                    bedrock: { enabled: true, type: "bedrock" },
                    claude: { enabled: false, type: "claude" },
                    codex: { enabled: false, type: "codex" },
                },
            }),
        ).toMatchObject({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [
                { disabledReason: "not_authenticated", providerId: "bedrock" },
                { disabledReason: "not_enabled", providerId: "claude" },
                { disabledReason: "not_enabled", providerId: "codex" },
            ],
        });
    });

    it("represents a custom Bedrock provider with a missing credential", () => {
        expect(
            createModelCatalog({
                env: {},
                providers: {
                    work_bedrock: {
                        bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                        enabled: true,
                        type: "bedrock",
                    },
                },
            }),
        ).toMatchObject({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [{ disabledReason: "not_authenticated", providerId: "work_bedrock" }],
        });
    });

    it("represents providers disabled by direct daemon auth checks", () => {
        expect(
            createModelCatalog({
                disabledProviderReasons: new Map([
                    ["codex", "not_authenticated"],
                    ["grok", "not_authenticated"],
                ]),
                providers: {
                    codex: { enabled: true, type: "codex" },
                    grok: { enabled: true, type: "grok" },
                },
            }),
        ).toMatchObject({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [
                { disabledReason: "not_authenticated", providerId: "codex" },
                { disabledReason: "not_authenticated", providerId: "grok" },
            ],
        });
    });

    it("represents providers pre-disabled because their model filters are empty", () => {
        expect(
            createModelCatalog({
                disabledProviderReasons: new Map([["codex", "no_models"]]),
                providers: { codex: { enabled: true, type: "codex" } },
            }),
        ).toMatchObject({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [{ disabledReason: "no_models", providerId: "codex" }],
        });
    });

    it("returns an empty catalog when every provider instance is disabled", () => {
        expect(
            createModelCatalog({
                providers: {
                    codex: { enabled: false, type: "codex" },
                    claude: { enabled: false, type: "claude" },
                    bedrock: { enabled: false, type: "bedrock" },
                },
            }),
        ).toMatchObject({
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [
                { disabledReason: "not_enabled", providerId: "codex" },
                { disabledReason: "not_enabled", providerId: "claude" },
                { disabledReason: "not_enabled", providerId: "bedrock" },
            ],
        });
    });
});
