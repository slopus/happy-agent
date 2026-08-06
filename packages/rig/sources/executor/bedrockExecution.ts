import {
    AnthropicBedrockProvider as NativeAnthropicBedrockProvider,
    BedrockBearerTokenCredential,
    CodexProvider,
} from "@slopus/rig-providers";
import { createExecutorModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";

import { BEDROCK_MODEL_ROUTES } from "./bedrock-model-routes.js";
import type { BedrockModelOverrides } from "./bedrock-model-overrides.js";
import { getBedrockModelRoute } from "./getBedrockModelRoute.js";
import { readBedrockBearerToken } from "./readBedrockBearerToken.js";
import { resolveBedrockModelEndpoint } from "./resolveBedrockModelEndpoint.js";
import { resolveBedrockModelRegion } from "./resolveBedrockModelRegion.js";
import { resolveBedrockModelTransport } from "./resolveBedrockModelTransport.js";
import { resolveBedrockRegion } from "./resolveBedrockRegion.js";

export const BEDROCK_PROVIDER_ID = "bedrock";

export interface BedrockProviderOptions {
    agentId?: string;
    bearerToken?: string;
    env?: NodeJS.ProcessEnv;
    id?: string;
    modelOverrides?: BedrockModelOverrides;
    region?: string;
    resolveInferenceMaxRetries?: () => number;
}

export function bedrockExecution(options: BedrockProviderOptions = {}): ExecutorProvider {
    const env = options.env ?? process.env;
    const bearerToken = options.bearerToken ?? readBedrockBearerToken(env);
    if (bearerToken === undefined) {
        throw new Error(
            "Amazon Bedrock requires the AWS_BEARER_TOKEN_BEDROCK environment variable.",
        );
    }

    const defaultRegion = options.region?.trim() || resolveBedrockRegion(env);
    const routes = BEDROCK_MODEL_ROUTES.filter((route) => {
        const region = resolveBedrockModelRegion(
            route.model.id,
            defaultRegion,
            options.modelOverrides,
        );
        return (
            resolveBedrockModelTransport(
                route,
                region,
                options.modelOverrides?.[route.model.id],
            ) !== undefined
        );
    });

    const id = options.id ?? BEDROCK_PROVIDER_ID;
    return {
        id,
        profiles: createExecutorModelProfiles({
            models: routes.map((route) => route.model),
            providerId: id,
            providerType: "bedrock",
        }),
        sessionId: options.agentId ?? id,
        nativeKey: (profile) => {
            const region = resolveBedrockModelRegion(
                profile.id,
                defaultRegion,
                options.modelOverrides,
            );
            const route = getBedrockModelRoute(profile.id);
            const transport =
                route === undefined
                    ? undefined
                    : resolveBedrockModelTransport(
                          route,
                          region,
                          options.modelOverrides?.[profile.id],
                      );
            const endpoint =
                route === undefined || transport === undefined
                    ? undefined
                    : resolveBedrockModelEndpoint(
                          route,
                          region,
                          transport,
                          options.modelOverrides?.[profile.id],
                      );
            return JSON.stringify([profile.id, endpoint, region, transport]);
        },
        native: async (profile) => {
            const region = resolveBedrockModelRegion(
                profile.id,
                defaultRegion,
                options.modelOverrides,
            );
            const route = getBedrockModelRoute(profile.id);
            if (route === undefined || !routes.includes(route)) {
                throw new Error(
                    `Amazon Bedrock model '${profile.name}' is not available in ${region}.`,
                );
            }
            const transport = resolveBedrockModelTransport(
                route,
                region,
                options.modelOverrides?.[profile.id],
            );
            if (transport === undefined) {
                throw new Error(
                    `Amazon Bedrock model '${profile.name}' is not available in ${region}.`,
                );
            }
            const endpoint = resolveBedrockModelEndpoint(
                route,
                region,
                transport,
                options.modelOverrides?.[profile.id],
            );
            const credential = await BedrockBearerTokenCredential.tryLoad({
                bearerToken,
            });
            if (credential === null) {
                throw new Error("Amazon Bedrock authentication is unavailable.");
            }
            return route.provider === "anthropic"
                ? new NativeAnthropicBedrockProvider({
                      credential,
                      endpoint,
                      model: route.model.id,
                      ...(options.resolveInferenceMaxRetries === undefined
                          ? {}
                          : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                      region,
                      transport,
                  })
                : new CodexProvider({
                      credential,
                      endpoint,
                      model: route.model.id,
                      region,
                      ...(options.resolveInferenceMaxRetries === undefined
                          ? {}
                          : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                  });
        },
    };
}
