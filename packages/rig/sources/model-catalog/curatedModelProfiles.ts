import { knownModels } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";

import type { ModelCatalogProfile } from "./ModelCatalogProfile.js";

const modelById = new Map(knownModels.map((model) => [model.id, model]));

export function curatedModel(id: string) {
    const model = modelById.get(id);
    if (model === undefined) {
        throw new Error(`The curated model catalog has no model '${id}'.`);
    }
    return model;
}

export function curatedModelProfiles(
    providerId: string,
    providerType: ProviderModelCompatibilityType,
): readonly ModelCatalogProfile[] {
    const ids =
        providerType === "claude"
            ? [
                  "anthropic/opus-5",
                  "anthropic/sonnet-5",
                  "anthropic/fable-5",
                  "anthropic/opus-4-8",
              ]
            : providerType === "codex"
              ? [
                    "openai/gpt-5.6-sol",
                    "openai/gpt-5.6-terra",
                    "openai/gpt-5.6-luna",
                    "openai/codex-auto-review",
                ]
              : providerType === "grok"
                ? ["xai/grok-build", "xai/grok-4.5", "xai/grok-composer-2.5-fast"]
                : [];
    return ids.map((id) => ({
        ...(id === "openai/codex-auto-review" ? { hidden: true } : {}),
        id,
        model: curatedModel(id),
        providerId,
        providerType,
    }));
}