import {
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
} from "@slopus/rig-providers";
import { builtinModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";

import type { ConfigGrokProvider } from "../config/types.js";

export function grokExecution(options: {
    apiKey?: string;
    config: ConfigGrokProvider;
    env: NodeJS.ProcessEnv;
    id: string;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const baseUrl = options.config.baseUrl ?? options.env.RIG_GROK_BASE_URL;
    return {
        id: options.id,
        profiles: builtinModelProfiles(options.id, "grok"),
        sessionId: options.sessionId ?? options.id,
        native: async () => {
            const credential =
                (await GrokApiKeyCredential.tryLoad({
                    env: options.env,
                    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
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
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            });
        },
    };
}
