import {
    CodexImageGenerationError,
    CodexProvider,
    loadCodexCredential,
} from "@slopus/happy-providers";
import {
    builtinModelProfiles,
    ExecutorImageGenerationUnavailableError,
    type ExecutorProvider,
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
    id: string;
    resolveInferenceFatalRetries?: () => number;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const apiKey = options.config.apiKey ?? options.apiKey;
    const configuredBaseUrl = options.config.baseUrl ?? options.env.RIG_CODEX_BASE_URL;
    const transport = options.config.transport ?? options.env.RIG_CODEX_TRANSPORT;
    const loadNativeConfiguration = async () =>
        configuredBaseUrl === undefined && options.config.credentialIsolation !== true
            ? loadNativeCodexProviderConfig(options.env)
            : null;
    const loadCredential = async (
        nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>,
    ) => {
        const access = resolveNativeCodexCredentialAccess({
            ...(apiKey === undefined ? {} : { apiKey }),
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
    const createNative = (
        credential: NonNullable<Awaited<ReturnType<typeof loadCredential>>>,
        nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>,
    ) => {
        const baseUrl = configuredBaseUrl ?? nativeConfiguration?.baseUrl;
        return new CodexProvider({
            credential,
            parallelToolCalls: true,
            ...(options.resolveInferenceFatalRetries === undefined
                ? {}
                : { resolveInferenceFatalRetries: options.resolveInferenceFatalRetries }),
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
    const native = () => async (): Promise<CodexProvider> => {
        const nativeConfiguration = await loadNativeConfiguration();
        const credential = await loadCredential(nativeConfiguration);
        if (credential === null) {
            throw new Error(
                "Codex authentication is unavailable. Sign in with Codex or configure an API key.",
            );
        }
        return createNative(credential, nativeConfiguration);
    };
    const profiles = builtinModelProfiles(options.id, "codex");
    const definition: ExecutorProvider = {
        id: options.id,
        isolated: () => definition,
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
        profiles,
        // Hidden profiles are not the user's to spend, so nothing of theirs is offered.
        serviceTiers: ["fast"],
        sessionId: options.sessionId ?? options.id,
        native: native(),
    };
    return definition;
}
