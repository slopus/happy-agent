import {
    CodexImageGenerationError,
    CodexProvider,
    loadCodexCredential,
} from "@slopus/rig-providers";
import {
    builtinModelProfiles,
    ExecutorImageGenerationUnavailableError,
    type ExecutorProvider,
} from "@slopus/rig-execution";

import type { ConfigCodexProvider } from "../config/types.js";
import { loadNativeCodexProviderConfig } from "./loadNativeCodexProviderConfig.js";

export function codexExecution(options: {
    apiKey?: string;
    config: ConfigCodexProvider;
    env: NodeJS.ProcessEnv;
    id: string;
    resolveStreamMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const configuredBaseUrl = options.config.baseUrl ?? options.env.RIG_CODEX_BASE_URL;
    const transport = options.config.transport ?? options.env.RIG_CODEX_TRANSPORT;
    const loadNativeConfiguration = async () =>
        configuredBaseUrl === undefined ? loadNativeCodexProviderConfig(options.env) : null;
    const loadCredential = async (
        nativeConfiguration: Awaited<ReturnType<typeof loadNativeConfiguration>>,
    ) => {
        const nativeBearerToken =
            configuredBaseUrl === undefined &&
            options.config.authFile === undefined &&
            !options.apiKey?.trim() &&
            nativeConfiguration?.baseUrl !== undefined
                ? nativeConfiguration.experimentalBearerToken
                : undefined;
        if (
            configuredBaseUrl === undefined &&
            options.config.authFile === undefined &&
            !options.apiKey?.trim() &&
            nativeConfiguration?.baseUrl !== undefined &&
            nativeConfiguration.requiresOpenAiAuth === false &&
            nativeBearerToken === undefined
        ) {
            return null;
        }
        const apiKey = options.apiKey ?? nativeBearerToken;
        return loadCodexCredential({
            ...(apiKey === undefined ? {} : { apiKey }),
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
            ...(options.resolveStreamMaxRetries === undefined
                ? {}
                : { resolveStreamMaxRetries: options.resolveStreamMaxRetries }),
            ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            ...(transport === "auto" || transport === "sse" || transport === "websocket"
                ? { transport }
                : transport === "websocket-cached"
                  ? { transport: "websocket" as const }
                  : {}),
        });
    };
    const native = async () => {
        const nativeConfiguration = await loadNativeConfiguration();
        const credential = await loadCredential(nativeConfiguration);
        if (credential === null) {
            throw new Error(
                "Codex authentication is unavailable. Sign in with Codex or configure an API key.",
            );
        }
        return createNative(credential, nativeConfiguration);
    };
    return {
        id: options.id,
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
                    return await createNative(credential, nativeConfiguration).generateImage(request);
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
        native,
    };
}
