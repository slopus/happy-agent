import { defineModel } from "@slopus/rig-execution";

import type { ModelCatalog } from "../protocol/index.js";
import { readGymContextWindow } from "./readGymContextWindow.js";

const gymModel = defineModel({
    id: "openai/gym",
    name: "Gym",
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultThinkingLevel: "off",
    contextWindow: 272_000,
});

/**
 * The gym provider's catalog entry, present only when a gym inference endpoint is configured. The
 * gym exposes a single curated model; a context-window override applies when the environment sets
 * one. This is metadata only — real gym inference is served by the agent's own gym provider.
 */
export function gymCatalogProvider(
    env: NodeJS.ProcessEnv,
): ModelCatalog["providers"][number] | undefined {
    const endpoint = env.RIG_GYM_INFERENCE_URL?.trim();
    if (endpoint === undefined || endpoint.length === 0) return undefined;
    const contextWindow = readGymContextWindow(env);
    return {
        models: contextWindow === undefined ? [gymModel] : [{ ...gymModel, contextWindow }],
        providerId: "gym",
        providerType: "gym",
        serviceTiers: ["fast"],
    };
}
