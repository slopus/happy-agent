import { GrokApiKeyCredential, GrokProvider, GrokSessionCredential } from "@slopus/happy-providers";
import { builtinModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";

import type { ConfigGrokProvider } from "../config/types.js";

export function grokExecution(options: {
    apiKey?: string;
    config: ConfigGrokProvider;
    env: NodeJS.ProcessEnv;
    id: string;
    resolveInferenceFatalRetries?: () => number;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const apiKey = options.config.apiKey ?? options.apiKey;
    const baseUrl = options.config.baseUrl ?? options.env.RIG_GROK_BASE_URL;
    const build = (): ExecutorProvider["native"] => {
        return async () => {
            const credential =
                (await GrokApiKeyCredential.tryLoad({
                    env: options.env,
                    ...(apiKey === undefined ? {} : { apiKey }),
                    ...(options.config.authFile === undefined
                        ? {}
                        : { authFile: options.config.authFile }),
                })) ??
                (await GrokSessionCredential.tryLoad({
                    env: options.env,
                    ...(options.config.authFile === undefined
                        ? {}
                        : { authFile: options.config.authFile }),
                }));
            if (credential === null) {
                throw new Error(
                    "Grok authentication is unavailable. Sign in with Grok or configure XAI_API_KEY.",
                );
            }
            return new GrokProvider({
                credential,
                ...(options.resolveInferenceFatalRetries === undefined
                    ? {}
                    : { resolveInferenceFatalRetries: options.resolveInferenceFatalRetries }),
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            });
        };
    };
    const profiles = builtinModelProfiles(options.id, "grok");
    const definition: ExecutorProvider = {
        id: options.id,
        isolated: () => definition,
        profiles,
        sessionId: options.sessionId ?? options.id,
        native: build(),
    };
    return definition;
}
