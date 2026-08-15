import {
    createProviderQuotaCache,
    fetchCodexProviderQuota,
    type ProviderQuota,
    type ProviderUsage,
    unavailableProviderQuota,
} from "@slopus/happy-providers";

import type { ConfigProviders } from "../config/types.js";
import { providerUsageToClaudeQuota } from "./providerUsageToClaudeQuota.js";
import { providerCredentialEnvironment } from "./providerCredentialEnvironment.js";

export interface ProviderQuotaService {
    get(providerId: string): Promise<ProviderQuota | undefined>;
}

export interface CreateProviderQuotaServiceOptions {
    env?: NodeJS.ProcessEnv;
    loadClaudeUsage?: (providerId: string) => Promise<ProviderUsage | null>;
    loadCodexQuota?: () => Promise<ProviderQuota>;
    now?: () => number;
    providers?: ConfigProviders;
}

export function createProviderQuotaService(
    options: CreateProviderQuotaServiceOptions,
): ProviderQuotaService {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const codex = new Map<string, ReturnType<typeof createProviderQuotaCache>>();

    return {
        async get(providerId) {
            const configuredProvider = options.providers?.[providerId];
            if (
                (configuredProvider === undefined && providerId === "codex") ||
                configuredProvider?.type === "codex"
            ) {
                const providerEnv =
                    configuredProvider === undefined
                        ? env
                        : providerCredentialEnvironment(configuredProvider, env);
                let cache = codex.get(providerId);
                if (cache === undefined) {
                    cache = createProviderQuotaCache(
                        options.loadCodexQuota ??
                            (() =>
                                configuredProvider?.apiKey === undefined
                                    ? fetchCodexProviderQuota({
                                          ...(configuredProvider?.authFile === undefined
                                              ? {}
                                              : { authPath: configuredProvider.authFile }),
                                          ...(env.RIG_CODEX_BASE_URL === undefined
                                              ? {}
                                              : { baseUrl: env.RIG_CODEX_BASE_URL }),
                                          now,
                                          env: providerEnv,
                                      })
                                    : Promise.resolve(unavailableProviderQuota("codex", now()))),
                        { now },
                    );
                    codex.set(providerId, cache);
                }
                return cache.get();
            }
            if (providerId !== "claude" && configuredProvider?.type !== "claude") {
                return undefined;
            }
            if (options.loadClaudeUsage === undefined) return undefined;
            try {
                return providerUsageToClaudeQuota(await options.loadClaudeUsage(providerId), now());
            } catch {
                return unavailableProviderQuota("claude", now());
            }
        },
    };
}
