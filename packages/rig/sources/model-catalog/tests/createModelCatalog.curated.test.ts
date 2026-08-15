import { describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    createModelCatalog as createModelCatalogWithContext,
    type CreateModelCatalogOptions,
} from "../createModelCatalog.js";

// Pins the curated model catalog for the common configurations. The catalog is derived entirely
// from Rig's hardcoded model definitions rather than by interrogating any provider, so its shape
// must not drift silently when the derivation changes. Each expectation captures the full
// provider/model structure a daemon would present.
const createModelCatalog = (options?: CreateModelCatalogOptions) =>
    createModelCatalogWithContext(createTestRootContext().named("curated-catalog"), options);

const providerShape = (
    catalog: ReturnType<typeof createModelCatalog>,
    providerId: string,
): {
    providerType: string;
    disabledReason: string | undefined;
    serviceTiers: readonly string[] | undefined;
    modelIds: readonly string[];
} => {
    const provider = catalog.providers.find((entry) => entry.providerId === providerId);
    if (provider === undefined) {
        throw new Error(`Provider '${providerId}' is missing from the catalog.`);
    }
    return {
        providerType: provider.providerType,
        disabledReason: provider.disabledReason,
        serviceTiers: provider.serviceTiers,
        modelIds: provider.models.map((model) => model.id),
    };
};

describe("createModelCatalog curated catalog", () => {
    it("pins the default configuration without any credentials", () => {
        const catalog = createModelCatalog({ env: {} });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            "claude",
            "bedrock",
            "grok",
        ]);
        expect(catalog.defaultProviderId).toBe("codex");
        expect(catalog.defaultModelId).toBe("openai/gpt-5.6-sol");
        expect(providerShape(catalog, "codex")).toEqual({
            providerType: "codex",
            disabledReason: undefined,
            serviceTiers: ["fast"],
            modelIds: ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna"],
        });
        expect(providerShape(catalog, "claude")).toEqual({
            providerType: "claude",
            disabledReason: undefined,
            serviceTiers: undefined,
            modelIds: [
                "anthropic/opus-5",
                "anthropic/sonnet-5",
                "anthropic/fable-5",
                "anthropic/opus-4-8",
            ],
        });
        expect(providerShape(catalog, "grok")).toEqual({
            providerType: "grok",
            disabledReason: undefined,
            serviceTiers: undefined,
            modelIds: ["xai/grok-build", "xai/grok-4.5", "xai/grok-composer-2.5-fast"],
        });
        expect(providerShape(catalog, "bedrock")).toEqual({
            providerType: "bedrock",
            disabledReason: "not_authenticated",
            serviceTiers: undefined,
            modelIds: [],
        });
    });

    it("pins the Amazon Bedrock model list when its bearer token is present", () => {
        const catalog = createModelCatalog({
            env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-token", AWS_REGION: "us-east-1" },
        });

        expect(providerShape(catalog, "bedrock")).toEqual({
            providerType: "bedrock",
            disabledReason: undefined,
            serviceTiers: undefined,
            modelIds: [
                "anthropic/sonnet-5",
                "anthropic/fable-5",
                "anthropic/opus-5",
                "anthropic/opus-4-8",
                "openai/gpt-5.6-sol",
                "openai/gpt-5.6-terra",
                "openai/gpt-5.6-luna",
            ],
        });
    });

    it("pins the gym provider and default selection when a gym endpoint is configured", () => {
        const catalog = createModelCatalog({
            env: { RIG_GYM_INFERENCE_URL: "http://localhost:9999" },
        });

        expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
            "gym",
            "codex",
            "claude",
            "bedrock",
            "grok",
        ]);
        expect(catalog.defaultProviderId).toBe("gym");
        expect(catalog.defaultModelId).toBe("openai/gym");
        expect(providerShape(catalog, "gym")).toEqual({
            providerType: "gym",
            disabledReason: undefined,
            serviceTiers: ["fast"],
            modelIds: ["openai/gym"],
        });
    });
});
