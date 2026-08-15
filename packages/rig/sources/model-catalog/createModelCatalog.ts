import {
    builtinModelProfiles,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelOpenaiGpt56Terra,
    type ExecutorModelProfile,
} from "@slopus/rig-execution";

import { DEFAULT_RIG_CONFIG } from "../config/defaultConfig.js";
import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import type { ModelCatalog } from "../protocol/index.js";
import { bedrockCatalogProfiles } from "./bedrock/bedrockCatalogProfiles.js";
import { gymCatalogProvider } from "./gymCatalogProvider.js";
import { uniqueModelsById } from "./uniqueModelsById.js";
import type { Context } from "@steve.kite/stdlib";

export interface CreateModelCatalogOptions {
    cwd?: string;
    disabledProviderReasons?: ReadonlyMap<
        string,
        "not_authenticated" | "not_enabled" | "no_models"
    >;
    env?: NodeJS.ProcessEnv;
    providers?: ConfigProviders;
}

/**
 * The curated catalog of providers and models a configuration can select. It is derived entirely
 * from Rig's hardcoded model definitions rather than by interrogating any provider: each configured
 * provider contributes its built-in model profiles, filtered by that provider's include/exclude
 * lists and by whatever region and credentials it can actually reach. The daemon never lists models
 * from a provider API.
 */
export function createModelCatalog(
    _ctx: Context,
    options: CreateModelCatalogOptions = {},
): ModelCatalog {
    const env = options.env ?? process.env;
    const providerSettings = options.providers ?? DEFAULT_RIG_CONFIG.providers;
    const providerCatalogs: ModelCatalog["providers"][number][] = [];

    const gymProvider = gymCatalogProvider(env);
    const gymEnabled = gymProvider !== undefined;
    if (gymProvider !== undefined) {
        providerCatalogs.unshift(gymProvider);
    }

    for (const [id, config] of Object.entries(providerSettings)) {
        if (providerCatalogs.some((provider) => provider.providerId === id)) {
            throw new Error(`Inference provider '${id}' is configured more than once.`);
        }
        const configuredDisabledReason = options.disabledProviderReasons?.get(id);
        const disabledReason = !config.enabled
            ? "not_enabled"
            : configuredDisabledReason === "not_enabled"
              ? "not_enabled"
              : configuredDisabledReason;
        if (disabledReason !== undefined) {
            providerCatalogs.push({
                disabledReason,
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }

        const profiles = providerCatalogProfiles(id, config, env);
        if (profiles === undefined) {
            providerCatalogs.push({
                disabledReason: "not_authenticated",
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }
        const models = filterProviderProfiles(profiles, config)
            .filter((profile) => profile.hidden !== true)
            .map((profile) => profile.model);
        if (models.length === 0) {
            providerCatalogs.push({
                disabledReason: "no_models",
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }
        providerCatalogs.push({
            models,
            providerId: id,
            providerType: config.type,
            ...(config.type === "codex" ? { serviceTiers: ["fast"] as const } : {}),
        });
    }

    const availableProviders = providerCatalogs.filter(
        (provider) => provider.disabledReason === undefined && provider.models.length > 0,
    );
    const defaultProvider = availableProviders[0];
    if (defaultProvider === undefined) {
        return {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: providerCatalogs,
        };
    }
    const defaultModel = gymEnabled
        ? (defaultProvider.models.find((model) => model.id === "openai/gym") ??
          defaultProvider.models[0])
        : (defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Sol.id) ??
          defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Terra.id) ??
          defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Luna.id) ??
          defaultProvider.models[0]);
    if (defaultModel === undefined) {
        throw new Error("No inference models are currently available.");
    }

    return {
        defaultModelId: defaultModel.id,
        defaultProviderId: defaultProvider.providerId,
        models: uniqueModelsById(availableProviders.flatMap((provider) => provider.models)),
        providers: providerCatalogs,
    };
}

/**
 * The built-in model profiles a configured provider exposes, before its include/exclude filters are
 * applied. Bedrock alone can be unauthenticated at this point (its bearer token is absent); the
 * other providers report authentication separately through `disabledProviderReasons`.
 */
function providerCatalogProfiles(
    providerId: string,
    config: ConfigProvider,
    env: NodeJS.ProcessEnv,
): readonly ExecutorModelProfile[] | undefined {
    if (config.type === "bedrock") return bedrockCatalogProfiles(providerId, config, env);
    return builtinModelProfiles(providerId, config.type);
}

function filterProviderProfiles(
    profiles: readonly ExecutorModelProfile[],
    config: ConfigProvider,
): readonly ExecutorModelProfile[] {
    const included = config.includeModels === undefined ? undefined : new Set(config.includeModels);
    const excluded = new Set(config.excludeModels ?? []);
    return profiles.filter(
        (profile) =>
            (included === undefined || included.has(profile.id)) && !excluded.has(profile.id),
    );
}
