import { ProviderUsageRequestError, type ProviderUsage } from "@slopus/happy-providers";

import { PROVIDER_USAGE_POLL_INTERVAL_MS } from "./createProviderUsageTracker.js";

interface ProviderUsageCacheEntry {
    hasValue: boolean;
    lastError: unknown;
    nextLoadAt: number;
    pending: Promise<ProviderUsage | null> | undefined;
    retryAt: number;
    value: ProviderUsage | null;
}

export interface ProviderUsageService {
    get(providerId: string): Promise<ProviderUsage | null>;
    /**
     * Folds in a reading a provider volunteered during ordinary inference, and
     * answers with the account's complete picture afterwards.
     */
    record(usage: ProviderUsage): ProviderUsage;
}

export interface CreateProviderUsageServiceOptions {
    loadUsage: (providerId: string) => Promise<ProviderUsage | null>;
    minimumRefreshIntervalMs?: number;
    now?: () => number;
    onError?: (providerId: string, error: unknown) => void;
}

/**
 * Owns the one upstream usage reading for each configured provider.
 *
 * The daemon's scheduled poll and every quota display read pass through this
 * cache, so concurrent reads cannot issue duplicate requests and nothing asks
 * the vendor more often than the refresh interval or a provider retry boundary
 * allows. A failed refresh keeps serving the last successful reading.
 *
 * Readings a provider volunteers during ordinary inference are folded in
 * without asking the vendor anything, and without disturbing the schedule.
 */
export function createProviderUsageService(
    options: CreateProviderUsageServiceOptions,
): ProviderUsageService {
    const now = options.now ?? Date.now;
    const minimumRefreshIntervalMs =
        options.minimumRefreshIntervalMs ?? PROVIDER_USAGE_POLL_INTERVAL_MS;
    const entries = new Map<string, ProviderUsageCacheEntry>();

    function entryFor(providerId: string): ProviderUsageCacheEntry {
        let entry = entries.get(providerId);
        if (entry === undefined) {
            entry = {
                hasValue: false,
                lastError: undefined,
                nextLoadAt: 0,
                pending: undefined,
                retryAt: 0,
                value: null,
            };
            entries.set(providerId, entry);
        }
        return entry;
    }

    return {
        get(providerId) {
            const entry = entryFor(providerId);
            if (entry.pending !== undefined) return entry.pending;
            const currentTime = now();
            if (currentTime < entry.retryAt || currentTime < entry.nextLoadAt) {
                if (entry.hasValue) return Promise.resolve(entry.value);
                return Promise.reject(entry.lastError);
            }

            const request = options
                .loadUsage(providerId)
                .then((usage) => {
                    // An observation that arrived while this request was in
                    // flight describes the account more recently than the
                    // answer now coming back.
                    const value =
                        usage !== null &&
                        entry.value !== null &&
                        entry.value.capturedAt > usage.capturedAt
                            ? mergeObservedUsage(usage, entry.value)
                            : usage;
                    entry.hasValue = true;
                    entry.lastError = undefined;
                    entry.nextLoadAt = now() + minimumRefreshIntervalMs;
                    entry.retryAt = 0;
                    entry.value = value;
                    return value;
                })
                .catch((error: unknown) => {
                    entry.lastError = error;
                    const providerRetryAt =
                        error instanceof ProviderUsageRequestError ? error.retryAt : undefined;
                    entry.retryAt = Math.max(
                        now() + minimumRefreshIntervalMs,
                        providerRetryAt ?? 0,
                    );
                    entry.nextLoadAt = entry.retryAt;
                    options.onError?.(providerId, error);
                    if (entry.hasValue) return entry.value;
                    throw error;
                })
                .finally(() => {
                    if (entry.pending === request) entry.pending = undefined;
                });
            entry.pending = request;
            return request;
        },
        record(usage) {
            const entry = entryFor(usage.providerId);
            const merged = mergeObservedUsage(entry.hasValue ? entry.value : null, usage);
            entry.hasValue = true;
            entry.lastError = undefined;
            entry.value = merged;
            return merged;
        },
    };
}

/**
 * An observation made during inference reports only the window that currently
 * constrains the account, so everything it leaves unsaid keeps the value the
 * last full reading gave it.
 */
function mergeObservedUsage(
    previous: ProviderUsage | null,
    observed: ProviderUsage,
): ProviderUsage {
    if (previous === null) return observed;
    return {
        ...observed,
        planName: observed.planName ?? previous.planName,
        credits: observed.credits ?? previous.credits,
        windows: {
            fiveHour: observed.windows.fiveHour ?? previous.windows.fiveHour,
            weekly: observed.windows.weekly ?? previous.windows.weekly,
            monthly: observed.windows.monthly ?? previous.windows.monthly,
        },
    };
}
