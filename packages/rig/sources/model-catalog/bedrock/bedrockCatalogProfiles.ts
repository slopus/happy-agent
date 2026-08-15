import type { ConfigBedrockProvider } from "../../config/types.js";
import { curatedModelProfiles } from "../curatedModelProfiles.js";
import type { ModelCatalogProfile } from "../ModelCatalogProfile.js";
import { BEDROCK_MODEL_ROUTES } from "./bedrock-model-routes.js";
import { readConfiguredBedrockBearerToken } from "./readConfiguredBedrockBearerToken.js";
import { resolveBedrockModelRegion } from "./resolveBedrockModelRegion.js";
import { resolveBedrockModelTransport } from "./resolveBedrockModelTransport.js";
import { resolveBedrockRegion } from "./resolveBedrockRegion.js";

/**
 * The Amazon Bedrock models a configuration can currently reach, as curated profiles. This mirrors
 * the model listing the executor-backed provider used to expose: it filters the static model routes
 * by the region and transport each configured model resolves to, and returns nothing when no bearer
 * token is available so the caller can mark the provider unauthenticated. It deliberately builds no
 * inference transport — only the catalog's view of which models exist.
 */
export function bedrockCatalogProfiles(
    providerId: string,
    config: ConfigBedrockProvider,
    env: NodeJS.ProcessEnv,
): readonly ModelCatalogProfile[] | undefined {
    const bearerToken = readConfiguredBedrockBearerToken(config, env);
    if (bearerToken === undefined) return undefined;
    const defaultRegion = config.region?.trim() || resolveBedrockRegion(env);
    const routes = BEDROCK_MODEL_ROUTES.filter((route) => {
        const region = resolveBedrockModelRegion(route.model.id, defaultRegion, config.modelOverrides);
        return (
            resolveBedrockModelTransport(route, region, config.modelOverrides?.[route.model.id]) !==
            undefined
        );
    });
    const builtins = new Map(
        [
            ...curatedModelProfiles(providerId, "claude"),
            ...curatedModelProfiles(providerId, "codex"),
        ].map((profile) => [profile.id, profile]),
    );
    return routes.map((route) => {
        const profile = builtins.get(route.model.id);
        if (profile === undefined) {
            throw new Error(`The curated Bedrock catalog has no model '${route.model.id}'.`);
        }
        return {
            ...profile,
            model: route.model,
            providerType: "bedrock",
        };
    });
}
