import type { ModelCatalog } from "../../protocol/index.js";
import type { Model } from "../../protocol/index.js";

export interface InitialModelSelection {
    model: Model;
    providerId: string;
}

export function resolveInitialModelSelection(
    catalog: ModelCatalog,
    modelId: string,
    providerId: string,
): InitialModelSelection {
    const requestedProvider = catalog.providers.find(
        (provider) => provider.providerId === providerId,
    );
    const requestedModel = requestedProvider?.models.find((model) => model.id === modelId);
    if (requestedModel !== undefined) {
        return { model: requestedModel, providerId };
    }

    for (const provider of catalog.providers) {
        const model = provider.models.find((candidate) => candidate.id === modelId);
        if (model !== undefined) {
            return { model, providerId: provider.providerId };
        }
    }

    const defaultProvider = catalog.providers.find(
        (provider) => provider.providerId === catalog.defaultProviderId,
    );
    const defaultModel = defaultProvider?.models.find(
        (model) => model.id === catalog.defaultModelId,
    );
    if (defaultModel !== undefined) {
        return { model: defaultModel, providerId: catalog.defaultProviderId };
    }

    for (const provider of catalog.providers) {
        const model = provider.models.find((candidate) => candidate.id === catalog.defaultModelId);
        if (model !== undefined) {
            return { model, providerId: provider.providerId };
        }
    }

    for (const provider of catalog.providers) {
        const model = provider.models[0];
        if (model !== undefined) {
            return { model, providerId: provider.providerId };
        }
    }

    throw new Error("No inference models are currently available.");
}
