import { createGymProvider } from "./createGymProvider.js";
import { readGymContextWindow } from "../model-catalog/readGymContextWindow.js";
import type { Provider } from "@slopus/rig-execution";

export function createGymProviderFromEnvironment(env: NodeJS.ProcessEnv): Provider | undefined {
    const endpoint = env.RIG_GYM_INFERENCE_URL?.trim();
    if (endpoint === undefined || endpoint.length === 0) return undefined;
    const contextWindow = readGymContextWindow(env);
    return createGymProvider({
        ...(contextWindow === undefined ? {} : { contextWindow }),
        endpoint,
        ...(env.RIG_GYM_TOKEN === undefined ? {} : { token: env.RIG_GYM_TOKEN }),
    });
}
