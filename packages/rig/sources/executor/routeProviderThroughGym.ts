import type { ProviderUsage } from "@slopus/happy-providers";

import { createGymProvider } from "./createGymProvider.js";
import { readGymContextWindow } from "../model-catalog/readGymContextWindow.js";
import type { Provider } from "@slopus/rig-execution";
import { Executor } from "@slopus/rig-execution";

export function routeProviderThroughGym(
    provider: Provider,
    env: NodeJS.ProcessEnv,
    onAccountUsage?: (usage: ProviderUsage) => void,
): Provider {
    const overrides = new Set(
        (env.RIG_GYM_PROVIDER_OVERRIDES ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    if (!overrides.has(provider.id)) return provider;

    const endpoint = env.RIG_GYM_INFERENCE_URL?.trim();
    if (endpoint === undefined || endpoint.length === 0) {
        throw new Error("RIG_GYM_INFERENCE_URL is required for Gym provider overrides.");
    }
    const contextWindow = readGymContextWindow(env);
    const gymProvider = createGymProvider({
        ...(contextWindow === undefined ? {} : { contextWindow }),
        endpoint,
        ...(provider.extendProfilePromptContext === undefined
            ? {}
            : { extendProfilePromptContext: provider.extendProfilePromptContext }),
        models: provider.models,
        ...(onAccountUsage === undefined ? {} : { onAccountUsage }),
        ...(provider instanceof Executor
            ? {
                  prepareContext: async (model, context) => ({
                      ...context,
                      systemPrompt: await provider.systemPrompt(
                          { modelId: model.id, providerId: provider.id },
                          context.systemPrompt,
                          context.systemPromptOverride,
                      ),
                  }),
              }
            : {}),
        providerId: provider.id,
        ...(provider.type === undefined ? {} : { providerType: provider.type }),
        ...(provider.serviceTiers === undefined ? {} : { serviceTiers: provider.serviceTiers }),
        ...(env.RIG_GYM_TOKEN === undefined ? {} : { token: env.RIG_GYM_TOKEN }),
    });
    return {
        ...gymProvider,
        ...(provider.close === undefined && gymProvider.close === undefined
            ? {}
            : {
                  close: async () => {
                      await Promise.all([gymProvider.close?.(), provider.close?.()]);
                  },
              }),
        // Isolating has to happen on the real provider and then be routed, not skipped. Routing
        // replaces the provider object, so a gym session that isolated the routed one would keep
        // whatever the conversation itself holds — and a test would see a side channel granted
        // capabilities that production withholds from it.
        ...(provider.isolate === undefined
            ? {}
            : {
                  isolate: (label: string) =>
                      routeProviderThroughGym(provider.isolate!(label), env, onAccountUsage),
              }),
        ...(provider.selectProvider === undefined
            ? {}
            : { selectProvider: provider.selectProvider.bind(provider) }),
        ...(provider.reviewerModelFor === undefined
            ? {}
            : { reviewerModelFor: provider.reviewerModelFor.bind(provider) }),
    };
}
