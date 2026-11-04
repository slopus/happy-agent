import { homedir } from "node:os";
import { join } from "node:path";

import {
    fetchClaudeProviderUsage,
    type ClaudeUsageEndpointRefusal,
    fetchCodexProviderUsage,
    fetchGrokProviderUsage,
    type ProviderUsage,
} from "@slopus/happy-providers";

import type { HappyAgentConfigValues } from "../ConfigModule.js";
import { readClaudeSettingsEnvironment } from "./readClaudeSettingsEnvironment.js";

export interface LoadConfiguredProviderUsageOptions {
    readonly environment: NodeJS.ProcessEnv;
    readonly providerId: string;
    readonly providers: HappyAgentConfigValues["providers"];
    readonly ignoreEnabled?: boolean;
    readonly signal?: AbortSignal;
    /** How to read an account whose vendor offers more than one way. */
    readonly method?: ProviderUsageReadMethod;
}

/**
 * Choices a caller makes about how one read reaches the vendor. Only Claude has a choice: its
 * OAuth usage endpoint or the unified headers of a one-token inference response.
 */
export interface ProviderUsageReadMethod {
    /** Admit only the fallback inference request, after any inexpensive account endpoint. */
    readonly shouldProbe?: () => boolean;
    /** Skip the OAuth usage endpoint and measure the inference headers directly. */
    readonly skipUsageEndpoint?: boolean;
    /** Told when the OAuth usage endpoint refused this account, and until when. */
    readonly onUsageEndpointRefused?: (refusal: ClaudeUsageEndpointRefusal) => void;
}

/**
 * Whether an account can be asked for its usage at all. A smart alias, Bedrock, an API key, and a
 * disabled account have no account-usage source, so nothing is gained by asking.
 */
export function hasConfiguredProviderUsageSource(
    providers: HappyAgentConfigValues["providers"],
    providerId: string,
): boolean {
    const provider = providers[providerId];
    if (provider === undefined) return false;
    if (provider.type !== "codex" && provider.type !== "claude" && provider.type !== "grok") {
        return false;
    }
    return provider.apiKey === undefined;
}

/** Ask one configured account through the usage API its vendor actually supplies. */
export async function loadConfiguredProviderUsage(
    options: LoadConfiguredProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const provider = options.providers[options.providerId];
    if (provider === undefined || (provider.enabled === false && options.ignoreEnabled !== true)) {
        return null;
    }
    // A smart provider spends through its concrete members, whose own entries carry usage.
    if (provider.type === "smart") return null;
    const env = providerEnvironment(provider.credentialIsolation === true, options.environment);
    const providerFetch = options.signal === undefined ? {} : { fetch: until(options.signal) };

    if (provider.type === "codex") {
        // An API key is billed independently from a ChatGPT subscription. Never attribute an
        // ambient Codex login's account usage to an explicitly configured API-key provider.
        if (provider.apiKey !== undefined) return null;
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
        if (provider.apiKey !== undefined) return null;
        // Inference applies the `env` block of Claude Code's settings, where a gateway's base URL
        // and token live, so the account is measured at the same endpoint with the same token.
        const settings =
            provider.credentialIsolation === true
                ? {}
                : (
                      await readClaudeSettingsEnvironment(
                          provider.configDir ??
                              (env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude")),
                      )
                  ).env;
        const claudeEnv = { ...env, ...settings };
        const configuredToken =
            provider.oauthToken ??
            provider.authToken ??
            (settings.ANTHROPIC_AUTH_TOKEN?.trim() || undefined);
        // A configured token is a `claude setup-token` or a gateway token: inference only, so the
        // OAuth usage endpoint would only refuse it. A stored login decides from its own scopes.
        const skipUsageEndpoint =
            options.method?.skipUsageEndpoint === true || configuredToken !== undefined;
        return fetchClaudeProviderUsage({
            ...(options.method?.shouldProbe === undefined
                ? {}
                : { shouldProbe: options.method.shouldProbe }),
            ...(skipUsageEndpoint ? { usageEndpoint: false } : {}),
            ...(options.method?.onUsageEndpointRefused === undefined
                ? {}
                : { onUsageEndpointRefused: options.method.onUsageEndpointRefused }),
            ...(claudeEnv.ANTHROPIC_BASE_URL === undefined
                ? {}
                : { baseUrl: claudeEnv.ANTHROPIC_BASE_URL }),
            // A gateway that routes by model name knows the account's own models, not Anthropic's.
            ...(claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL === undefined
                ? {}
                : { probeModel: claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL }),
            ...(provider.configDir === undefined ? {} : { configDir: provider.configDir }),
            ...(configuredToken === undefined ? {} : { oauthToken: configuredToken }),
            env: claudeEnv,
            providerId: options.providerId,
            ...providerFetch,
        });
    }
    if (provider.type === "grok") {
        // An explicit API key does not identify the CLI subscription account whose billing API
        // this reads, so do not silently fall back to an unrelated ambient login.
        if (provider.apiKey !== undefined) return null;
        return fetchGrokProviderUsage({
            ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
            env,
            providerId: options.providerId,
            ...providerFetch,
        });
    }

    // Bedrock usage belongs to AWS billing; Bedrock exposes no coding-account quota endpoint.
    return null;
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
