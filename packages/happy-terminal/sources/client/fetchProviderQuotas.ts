import { fetchCodexProviderQuota } from "@slopus/happy-providers";

import type { SessionProviderQuota } from "../protocol/index.js";

/**
 * Probes the current provider's account quota with this machine's own credentials.
 *
 * Happy Terminal signs in through the system coding assistants, so the quota that matters is the one their
 * credentials see; the terminal asks the vendor directly rather than adding a daemon surface for
 * it. Quota is a courtesy: a provider without a quota window, a missing credential, or a failed
 * probe all resolve to no quota rather than an error.
 */
export async function fetchProviderQuotas(
    providerId: string,
    providerType: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): Promise<readonly SessionProviderQuota[]> {
    if (providerType !== "codex") return [];
    const baseUrl = env.HAPPY_TERMINAL_CODEX_BASE_URL?.trim();
    const quota = await fetchCodexProviderQuota({
        ...(baseUrl === undefined || baseUrl.length === 0 ? {} : { baseUrl }),
        env,
    }).catch(() => undefined);
    return quota === undefined ? [] : [{ providerId, quota }];
}
