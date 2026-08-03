import {
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
    grok_hosted_tools,
} from "@slopus/rig-providers";
import {
    builtinModelProfiles,
    type ExecutorProvider,
    type HostedCapability,
} from "@slopus/rig-execution";

import type { ConfigGrokProvider } from "../config/types.js";

export function grokExecution(options: {
    apiKey?: string;
    config: ConfigGrokProvider;
    env: NodeJS.ProcessEnv;
    /**
     * Hosted searches this agent holds. Empty by default: a hosted search runs on Grok's backend
     * where Rig cannot review it, so it is granted at spawn or turned on for the root agent in
     * configuration, never assumed.
     */
    hostedCapabilities?: readonly HostedCapability[];
    id: string;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const baseUrl = options.config.baseUrl ?? options.env.RIG_GROK_BASE_URL;
    const granted = options.hostedCapabilities ?? [];
    const hostedTools = grok_hosted_tools.filter((tool) =>
        (granted as readonly string[]).includes(tool.name),
    );
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
                ...(hostedTools.length === 0 ? {} : { hostedTools }),
                ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            });
        },
    };
}
