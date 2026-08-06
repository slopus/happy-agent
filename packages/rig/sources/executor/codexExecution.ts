import {
    CodexImageGenerationError,
    CodexProvider,
    codex_hosted_tools,
    loadCodexCredential,
} from "@slopus/rig-providers";
import {
    builtinModelProfiles,
    ExecutorImageGenerationUnavailableError,
    type ExecutorProvider,
    type HostedCapability,
} from "@slopus/rig-execution";

import type { ConfigCodexProvider } from "../config/types.js";
import {
    loadNativeCodexProviderConfig,
    resolveNativeCodexCredentialAccess,
} from "./loadNativeCodexProviderConfig.js";

export function codexExecution(options: {
    apiKey?: string;
    config: ConfigCodexProvider;
    env: NodeJS.ProcessEnv;
    /**
     * The searches to declare on the request being built, asked once per request.
     *
     * Only the answer given while the request is being built can be enforced: OpenAI runs the
     * search inside its own response, so nothing about it can be taken back afterwards.
     */
    hostedCapabilitiesForRequest?: () => readonly HostedCapability[];
    id: string;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const configuredBaseUrl = options.config.baseUrl ?? options.env.RIG_CODEX_BASE_URL;
    const transport = options.config.transport ?? options.env.RIG_CODEX_TRANSPORT;
    const loadNativeConfiguration = async () =>
        configuredBaseUrl === undefined ? loadNativeCodexProviderConfig(options.env) : null;
    const loadCredential = async (
        nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>,
    ) => {
        const access = resolveNativeCodexCredentialAccess({
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.config.authFile === undefined ? {} : { authFile: options.config.authFile }),
            ...(configuredBaseUrl === undefined ? {} : { configuredBaseUrl }),
            nativeConfiguration,
        });
        if (access.status === "unsupported_wire_api") {
            throw new Error(
                `The selected native Codex provider uses an unsupported wire_api (${access.wireApi}). Rig supports responses only.`,
            );
        }
        if (access.status === "unavailable") return null;
        return loadCodexCredential({
            ...(access.apiKey === undefined ? {} : { apiKey: access.apiKey }),
            env: options.env,
            ...(options.config.authFile === undefined ? {} : { authFile: options.config.authFile }),
        });
    };
    const hostedTools = (capabilities: () => readonly HostedCapability[]) => () => {
        const held = capabilities();
        return held.length === 0
            ? []
            : codex_hosted_tools.filter((tool) => (held as readonly string[]).includes(tool.name));
    };
    const createNative = (
        credential: NonNullable<Awaited<ReturnType<typeof loadCredential>>>,
        nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>,
        capabilities: () => readonly HostedCapability[] = () =>
            options.hostedCapabilitiesForRequest?.() ?? [],
    ) => {
        const baseUrl = configuredBaseUrl ?? nativeConfiguration?.baseUrl;
        return new CodexProvider({
            credential,
            // Web search runs on OpenAI's backend the way the Codex CLI does, rather than through
            // a tool Rig would have to execute.
            hostedTools: hostedTools(capabilities),
            parallelToolCalls: true,
            ...(options.resolveInferenceMaxRetries === undefined
                ? {}
                : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
            ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            ...(transport === "auto" || transport === "sse" || transport === "websocket"
                ? { transport }
                : transport === "websocket-cached"
                  ? { transport: "websocket" as const }
                  : {}),
        });
    };
    const native =
        (capabilities?: () => readonly HostedCapability[]) => async (): Promise<CodexProvider> => {
            const nativeConfiguration = await loadNativeConfiguration();
            const credential = await loadCredential(nativeConfiguration);
            if (credential === null) {
                throw new Error(
                    "Codex authentication is unavailable. Sign in with Codex or configure an API key.",
                );
            }
            return capabilities === undefined
                ? createNative(credential, nativeConfiguration)
                : createNative(credential, nativeConfiguration, capabilities);
        };
    const definition: ExecutorProvider = {
        hostedCapabilitiesForRequest: () => options.hostedCapabilitiesForRequest?.() ?? [],
        id: options.id,
        // An isolate runs an auxiliary query the person never asked for and never sees: a title, or
        // the review that decides an action on their behalf. A search OpenAI runs on its own
        // backend is not Rig's to lend into one, and least of all into a reviewer, whose whole
        // input is material Rig already treats as untrusted.
        isolated: () => ({
            ...definition,
            hostedCapabilitiesForRequest: () => [],
            native: native(() => []),
        }),
        imageGeneration: {
            generate: async (request) => {
                let credential: Awaited<ReturnType<typeof loadCredential>>;
                let nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>;
                try {
                    nativeConfiguration = await loadNativeConfiguration();
                    credential = await loadCredential(nativeConfiguration);
                } catch (error) {
                    throw new ExecutorImageGenerationUnavailableError(
                        "A configured Codex image provider's authentication could not be loaded.",
                        { cause: error },
                    );
                }
                if (credential === null) {
                    throw new ExecutorImageGenerationUnavailableError(
                        "A configured Codex image provider has no available authentication.",
                    );
                }
                try {
                    return await createNative(credential, nativeConfiguration).generateImage(
                        request,
                    );
                } catch (error) {
                    if (error instanceof CodexImageGenerationError && error.fallbackEligible) {
                        throw new ExecutorImageGenerationUnavailableError(error.message, {
                            cause: error,
                        });
                    }
                    throw error;
                }
            },
        },
        profiles: builtinModelProfiles(options.id, "codex"),
        serviceTiers: ["fast"],
        sessionId: options.sessionId ?? options.id,
        native: native(),
    };
    return definition;
}
