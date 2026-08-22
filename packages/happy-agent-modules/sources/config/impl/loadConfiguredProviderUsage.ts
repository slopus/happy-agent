import {
    fetchClaudeProviderUsage,
    fetchCodexProviderUsage,
    fetchGrokProviderUsage,
    type ProviderUsage,
} from "@slopus/happy-providers";

import type { HappyAgentConfigValues } from "../ConfigModule.js";

export interface LoadConfiguredProviderUsageOptions {
    readonly environment: NodeJS.ProcessEnv;
    readonly providerId: string;
    readonly providers: HappyAgentConfigValues["providers"];
    readonly ignoreEnabled?: boolean;
    readonly signal?: AbortSignal;
}

/** Ask one configured account through the usage API its vendor actually supplies. */
export function loadConfiguredProviderUsage(
    options: LoadConfiguredProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const provider = options.providers[options.providerId];
    if (provider === undefined || (provider.enabled === false && options.ignoreEnabled !== true)) {
        return Promise.resolve(null);
    }
    const env = providerEnvironment(provider.credentialIsolation === true, options.environment);
    const providerFetch = options.signal === undefined ? {} : { fetch: until(options.signal) };

    if (provider.type === "codex") {
        // An API key is billed independently from a ChatGPT subscription. Never attribute an
        // ambient Codex login's account usage to an explicitly configured API-key provider.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchCodexProviderUsage({
            ...(provider.authFile === undefined ? {} : { authPath: provider.authFile }),
            env,
            providerId: options.providerId,
            ...providerFetch,
        });
    }
    if (provider.type === "claude") {
        // Anthropic API keys have no account-usage endpoint. OAuth and setup tokens use the
        // account-facing bearer flow, with rate-limit headers as the scoped-token fallback.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchClaudeProviderUsage({
            ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
            ...(provider.configDir === undefined ? {} : { configDir: provider.configDir }),
            ...((provider.oauthToken ?? provider.authToken) === undefined
                ? {}
                : { oauthToken: provider.oauthToken ?? provider.authToken }),
            env,
            providerId: options.providerId,
            ...providerFetch,
        });
    }
    if (provider.type === "grok") {
        // An explicit API key does not identify the CLI subscription account whose billing API
        // this reads, so do not silently fall back to an unrelated ambient login.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchGrokProviderUsage({
            ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
            env,
            providerId: options.providerId,
            ...providerFetch,
        });
    }

    // Bedrock usage belongs to AWS billing; Bedrock exposes no coding-account quota endpoint.
    return Promise.resolve(null);
}

/** Combine a vendor request's own timeout with the runtime lifetime that owns the poll. */
function until(lifetime: AbortSignal): typeof fetch {
    return async (input, init) => {
        const requestSignal = init?.signal;
        const signal =
            requestSignal === undefined || requestSignal === null
                ? lifetime
                : AbortSignal.any([requestSignal, lifetime]);
        return await fetch(input, { ...init, signal });
    };
}

/** Prevent an isolated provider from borrowing credentials from this machine's environment. */
function providerEnvironment(isolated: boolean, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!isolated) return environment;
    const result = { ...environment };
    for (const name of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_DEFAULT_REGION",
        "AWS_PROFILE",
        "AWS_REGION",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_VERTEX",
        "CODEX_HOME",
        "GROK_HOME",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
    ]) {
        delete result[name];
    }
    return result;
}
