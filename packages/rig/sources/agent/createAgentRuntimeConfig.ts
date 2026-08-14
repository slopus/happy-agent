import {
    AgentProviders,
    type AgentModel,
    type AgentProviderSource,
} from "@slopus/happy-agent-base";
import {
    AnthropicProvider,
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    CodexProvider,
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
    loadCodexCredential,
    type SessionReasoningEffort,
} from "@slopus/happy-providers";

import type {
    ConfigBedrockProvider,
    ConfigClaudeProvider,
    ConfigCodexProvider,
    ConfigGrokProvider,
    ConfigProvider,
    ConfigProviders,
} from "../config/types.js";
import type { ModelCatalog } from "../protocol/index.js";
import { GymAgentProvider } from "./GymAgentProvider.js";

export interface AgentRuntimeConfig {
    defaultProvider: string;
    models: readonly AgentModel[];
    providers: AgentProviders;
}

export function createAgentRuntimeConfig(options: {
    catalog: ModelCatalog;
    env: NodeJS.ProcessEnv;
    providers: ConfigProviders;
    resolveInferenceMaxRetries?: () => number;
}): AgentRuntimeConfig {
    const providers = new AgentProviders();
    const registeredProviderIds: string[] = [];
    const models: AgentModel[] = [];

    for (const catalogProvider of options.catalog.providers) {
        if (catalogProvider.providerId === "gym" && options.env.RIG_GYM_INFERENCE_URL?.trim()) {
            const endpoint = options.env.RIG_GYM_INFERENCE_URL.trim();
            providers.add(
                "gym",
                () =>
                    new GymAgentProvider({
                        endpoint,
                        ...(options.env.RIG_GYM_TOKEN === undefined
                            ? {}
                            : { token: options.env.RIG_GYM_TOKEN }),
                    }),
                "codex",
            );
            registeredProviderIds.push("gym");
            for (const model of catalogProvider.models) {
                const effortLevels = model.thinkingLevels
                    .map(toAgentEffort)
                    .filter((effort): effort is SessionReasoningEffort => effort !== undefined);
                models.push({
                    defaultEffort:
                        toAgentEffort(model.defaultThinkingLevel) ?? effortLevels[0] ?? "off",
                    effortLevels,
                    id: model.id,
                    name: model.name,
                    providerId: "gym",
                });
            }
            continue;
        }
        const config = options.providers[catalogProvider.providerId];
        if (config === undefined || !config.enabled) continue;
        providers.add(
            catalogProvider.providerId,
            createProviderSource(config, options),
            config.type,
        );
        registeredProviderIds.push(catalogProvider.providerId);
        for (const model of catalogProvider.models) {
            const effortLevels = model.thinkingLevels
                .map(toAgentEffort)
                .filter((effort): effort is SessionReasoningEffort => effort !== undefined);
            models.push({
                providerId: catalogProvider.providerId,
                id: model.id,
                name: model.name,
                effortLevels,
                defaultEffort:
                    toAgentEffort(model.defaultThinkingLevel) ?? effortLevels[0] ?? "medium",
                ...(catalogProvider.serviceTiers?.includes("fast")
                    ? { serviceTiers: ["priority"] as const }
                    : {}),
            });
        }
    }

    return {
        defaultProvider: registeredProviderIds.includes(options.catalog.defaultProviderId)
            ? options.catalog.defaultProviderId
            : (registeredProviderIds[0] ?? options.catalog.defaultProviderId),
        models,
        providers,
    };
}

function createProviderSource(
    config: ConfigProvider,
    options: {
        env: NodeJS.ProcessEnv;
        resolveInferenceMaxRetries?: () => number;
    },
): AgentProviderSource {
    switch (config.type) {
        case "bedrock":
            return createBedrockSource(config, options);
        case "claude":
            return createClaudeSource(config, options);
        case "codex":
            return createCodexSource(config, options);
        case "grok":
            return createGrokSource(config, options);
    }
}

function createCodexSource(
    config: ConfigCodexProvider,
    options: {
        env: NodeJS.ProcessEnv;
        resolveInferenceMaxRetries?: () => number;
    },
): AgentProviderSource {
    const configuredBaseUrl = config.baseUrl ?? options.env.RIG_CODEX_BASE_URL;
    const transport = config.transport ?? options.env.RIG_CODEX_TRANSPORT;
    return async () => {
        if (
            config.credentialIsolation === true &&
            config.apiKey === undefined &&
            config.authFile === undefined
        ) {
            throw new Error(
                "Codex authentication is unavailable for this isolated provider configuration.",
            );
        }
        const credential = await loadCodexCredential({
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            env: options.env,
            ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
        });
        if (credential === null) {
            throw new Error(
                "Codex authentication is unavailable. Sign in with Codex or configure an API key.",
            );
        }
        return new CodexProvider({
            credential,
            parallelToolCalls: true,
            ...(configuredBaseUrl === undefined ? {} : { endpoint: configuredBaseUrl }),
            ...(options.resolveInferenceMaxRetries === undefined
                ? {}
                : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
            ...(transport === "auto" || transport === "sse" || transport === "websocket"
                ? { transport }
                : transport === "websocket-cached"
                  ? { transport: "websocket" as const }
                  : {}),
        });
    };
}

function createClaudeSource(
    config: ConfigClaudeProvider,
    options: {
        env: NodeJS.ProcessEnv;
        resolveInferenceMaxRetries?: () => number;
    },
): AgentProviderSource {
    const environment = createClaudeEnvironment(config, options.env);
    const executable = config.executable ?? options.env.RIG_CLAUDE_CODE_EXECUTABLE;
    return async () => {
        const credential =
            (config.oauthToken === undefined
                ? null
                : await ClaudeOAuthCredential.tryLoad({
                      env: environment,
                      oauthToken: config.oauthToken,
                  })) ??
            (await ClaudeApiKeyCredential.tryLoad({
                ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
                env: environment,
            })) ??
            (await ClaudeAuthTokenCredential.tryLoad({
                ...(config.authToken === undefined ? {} : { authToken: config.authToken }),
                env: environment,
            })) ??
            (config.oauthToken === undefined
                ? await ClaudeOAuthCredential.tryLoad({ env: environment })
                : null) ??
            (await ClaudeCodeCredential.tryLoad({
                env: environment,
                ...(config.configDir === undefined ? {} : { configDir: config.configDir }),
            }));
        if (credential === null) {
            throw new Error(
                "Claude authentication is unavailable. Sign in with Claude Code or configure a credential.",
            );
        }
        return new AnthropicProvider({
            credential,
            env: environment,
            ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
            ...(options.resolveInferenceMaxRetries === undefined
                ? {}
                : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
        });
    };
}

function createGrokSource(
    config: ConfigGrokProvider,
    options: {
        env: NodeJS.ProcessEnv;
        resolveInferenceMaxRetries?: () => number;
    },
): AgentProviderSource {
    const apiKey = config.apiKey ?? options.env.XAI_API_KEY;
    const endpoint = config.baseUrl ?? options.env.RIG_GROK_BASE_URL;
    return async () => {
        const credential =
            (await GrokApiKeyCredential.tryLoad({
                env: options.env,
                ...(apiKey === undefined ? {} : { apiKey }),
                ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
            })) ??
            (await GrokSessionCredential.tryLoad({
                env: options.env,
                ...(config.authFile === undefined ? {} : { authFile: config.authFile }),
            }));
        if (credential === null) {
            throw new Error(
                "Grok authentication is unavailable. Sign in with Grok or configure XAI_API_KEY.",
            );
        }
        return new GrokProvider({
            credential,
            ...(endpoint === undefined ? {} : { endpoint }),
            ...(options.resolveInferenceMaxRetries === undefined
                ? {}
                : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
        });
    };
}

function createBedrockSource(
    _config: ConfigBedrockProvider,
    _options: {
        env: NodeJS.ProcessEnv;
        resolveInferenceMaxRetries?: () => number;
    },
): AgentProviderSource {
    return () => {
        throw new Error(
            "Amazon Bedrock inference is not connected to the new Agent Base core yet.",
        );
    };
}

function createClaudeEnvironment(
    config: ConfigClaudeProvider,
    env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const configured: NodeJS.ProcessEnv = {
        ...env,
        ...(config.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: config.configDir }),
        ...(config.oauthToken === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: config.oauthToken }),
    };
    if (config.oauthToken !== undefined) {
        delete configured.ANTHROPIC_API_KEY;
        delete configured.ANTHROPIC_AUTH_TOKEN;
        delete configured.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
        delete configured.CLAUDE_CODE_USE_BEDROCK;
        delete configured.CLAUDE_CODE_USE_FOUNDRY;
        delete configured.CLAUDE_CODE_USE_VERTEX;
    }
    return configured;
}

function toAgentEffort(value: string): SessionReasoningEffort | undefined {
    if (value === "ultra") return "max";
    if (
        value === "off" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    ) {
        return value;
    }
    return undefined;
}
