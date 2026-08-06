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
     * The searches to declare on the request being built, asked once per request.
     *
     * Deliberately one question rather than a held set and a separate gate: two answers about the
     * same thing drift, and only the answer given while the request is being built can be
     * enforced. Absent means this agent never searches on the provider's backend.
     */
    hostedCapabilitiesForRequest?: () => readonly HostedCapability[];
    id: string;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const baseUrl = options.config.baseUrl ?? options.env.RIG_GROK_BASE_URL;
    const build = (
        hostedCapabilities: () => readonly HostedCapability[],
    ): ExecutorProvider["native"] => {
        return async () => {
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
                // Web and X search run on Grok's backend, so a session that holds them gets them
                // the way the Grok CLI does rather than through a tool Rig would have to execute.
                // Asked again for every request, so narrowing the permission mode mid-session
                // takes hold at once rather than at the next session.
                hostedTools: () => {
                    const capabilities = hostedCapabilities();
                    return capabilities.length === 0
                        ? []
                        : grok_hosted_tools.filter((tool) =>
                              (capabilities as readonly string[]).includes(tool.name),
                          );
                },
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            });
        };
    };
    const definition: ExecutorProvider = {
        hostedCapabilitiesForRequest: () => options.hostedCapabilitiesForRequest?.() ?? [],
        id: options.id,
        // An isolate runs an auxiliary query the person never asked for and never sees. A search
        // Grok runs on its own backend is not Rig's to lend into one: it cannot be intercepted,
        // rendered, or accounted for there, and the material such a query carries — the very
        // material an auxiliary query exists to examine — is routinely untrusted.
        isolated: () => ({
            ...definition,
            hostedCapabilitiesForRequest: () => [],
            native: build(() => []),
        }),
        profiles: builtinModelProfiles(options.id, "grok"),
        sessionId: options.sessionId ?? options.id,
        native: build(() => options.hostedCapabilitiesForRequest?.() ?? []),
    };
    return definition;
}
