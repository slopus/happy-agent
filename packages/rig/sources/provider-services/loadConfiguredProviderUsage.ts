import {
    fetchClaudeProviderUsage,
    fetchCodexProviderUsage,
    fetchGrokProviderUsage,
    type ProviderUsage,
} from "@slopus/happy-providers";

import type { ConfigProviders } from "../config/types.js";
import { providerCredentialEnvironment } from "./providerCredentialEnvironment.js";

export interface LoadConfiguredProviderUsageOptions {
    env?: NodeJS.ProcessEnv;
    providerId: string;
    providers: ConfigProviders;
}

/**
 * Asks one configured provider for its usage, using its vendor's own way of
 * reporting it.
 *
 * A provider is identified by its configured type rather than its id, so a
 * second Codex or Claude account under any name is read the same way as the
 * first. Returns null when the vendor cannot report usage at all, which is the
 * case for Bedrock.
 */
export function loadConfiguredProviderUsage(
    options: LoadConfiguredProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const provider = options.providers[options.providerId];
    if (provider === undefined || !provider.enabled) return Promise.resolve(null);
    const env = providerCredentialEnvironment(provider, options.env ?? process.env);

    if (provider.type === "codex") {
        // API keys bill independently and do not expose ChatGPT subscription usage. Falling back
        // to a local Codex login here would attribute a remote credential's usage to the wrong
        // owner.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchCodexProviderUsage({
            ...(provider.authFile === undefined ? {} : { authPath: provider.authFile }),
            env,
            providerId: options.providerId,
        });
    }
    if (provider.type === "claude") {
        // Anthropic API keys have no subscription-usage endpoint. An auth token, however, uses
        // the same account-facing bearer flow as Claude Code OAuth for usage purposes.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchClaudeProviderUsage({
            ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
            ...(provider.configDir === undefined ? {} : { configDir: provider.configDir }),
            ...((provider.oauthToken ?? provider.authToken) === undefined
                ? {}
                : { oauthToken: provider.oauthToken ?? provider.authToken }),
            env,
            providerId: options.providerId,
        });
    }
    if (provider.type === "grok") {
        // Grok API keys do not identify a CLI subscription account, so never read an unrelated
        // local session while one is explicitly configured.
        if (provider.apiKey !== undefined) return Promise.resolve(null);
        return fetchGrokProviderUsage({
            ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
            env,
            providerId: options.providerId,
        });
    }
    // Bedrock bills through AWS, which reports no subscription usage of its own.
    return Promise.resolve(null);
}
