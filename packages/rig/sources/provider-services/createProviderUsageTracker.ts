import type { ProviderUsage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";

import { asyncQueue, forever, type GracefulShutdown } from "../concurrency/index.js";

/**
 * How often each provider is asked for its usage.
 *
 * Vendors rate-limit their own usage endpoints, and Claude reports the account
 * again during ordinary inference, so a patient schedule costs almost nothing
 * and keeps a busy account from being refused for asking too often.
 */
export const PROVIDER_USAGE_POLL_INTERVAL_MS = 60 * 60 * 1_000;

export interface ProviderUsageEntry {
    providerId: string;
    /** The last reading, or null when the provider has never answered. */
    usage: ProviderUsage | null;
    /** When we last finished asking, whatever the answer was. */
    checkedAt: number | null;
    /** Why the last attempt produced nothing, when it produced nothing. */
    error: string | null;
}

export interface ProviderUsageTracker {
    /** Every tracked provider, including those that have never answered. */
    all(): readonly ProviderUsageEntry[];
    get(providerId: string): ProviderUsageEntry | undefined;
    /** Stores a reading a provider volunteered, without asking it anything. */
    observe(usage: ProviderUsage): void;
    /** Asks one provider now, outside the schedule, and stores the result. */
    refresh(providerId: string): Promise<ProviderUsageEntry | undefined>;
    /** Brings every provider's reading up to date and returns them all. */
    refreshAll(): Promise<readonly ProviderUsageEntry[]>;
    /** Starts one polling loop per provider. */
    start(): void;
}

export interface CreateProviderUsageTrackerOptions {
    /** Asks one provider for its usage. Resolves null when it cannot answer. */
    loadUsage: (providerId: string) => Promise<ProviderUsage | null>;
    now?: () => number;
    intervalMs?: number;
    onError?: (providerId: string, error: unknown) => void;
    providerIds: readonly string[];
    shutdown: GracefulShutdown;
}

/**
 * Keeps each provider's latest usage in memory.
 *
 * One named `forever` per provider, so the providers poll in parallel and a
 * slow or broken vendor cannot hold up the others. Nothing is persisted and
 * nothing is pushed: a client that wants to draw this asks for it.
 */
export function createProviderUsageTracker(
    options: CreateProviderUsageTrackerOptions,
): ProviderUsageTracker {
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? PROVIDER_USAGE_POLL_INTERVAL_MS;
    const entries = new Map<string, ProviderUsageEntry>(
        options.providerIds.map((providerId) => [
            providerId,
            { providerId, usage: null, checkedAt: null, error: null },
        ]),
    );
    const pollingQueues = new Map(
        [...entries.keys()].map((providerId) => [providerId, asyncQueue()]),
    );
    const pollingContext = createRootContext().named("provider-usage");
    let started = false;

    async function poll(providerId: string): Promise<ProviderUsageEntry | undefined> {
        const entry = entries.get(providerId);
        const queue = pollingQueues.get(providerId);
        if (entry === undefined || queue === undefined) return undefined;
        return queue.runInLock(pollingContext, async () => {
            try {
                const usage = await options.loadUsage(providerId);
                entry.checkedAt = now();
                // A provider that cannot answer keeps its previous reading, which
                // stays honest because every reading carries its own capture time.
                if (usage !== null) {
                    entry.usage = usage;
                    entry.error = null;
                } else {
                    entry.error =
                        entry.usage === null ? "The provider did not report usage." : null;
                }
            } catch (error) {
                entry.checkedAt = now();
                entry.error =
                    entry.usage === null
                        ? error instanceof Error
                            ? error.message
                            : String(error)
                        : null;
                options.onError?.(providerId, error);
            }
            return entry;
        });
    }

    return {
        all() {
            return [...entries.values()];
        },
        get(providerId) {
            return entries.get(providerId);
        },
        observe(usage) {
            const entry = entries.get(usage.providerId);
            if (entry === undefined) return;
            entry.checkedAt = now();
            entry.error = null;
            entry.usage = usage;
        },
        refresh(providerId) {
            return poll(providerId);
        },
        async refreshAll() {
            // A provider that cannot answer keeps its previous reading, so one
            // slow or broken vendor never withholds the others.
            await Promise.all([...entries.keys()].map((providerId) => poll(providerId)));
            return [...entries.values()];
        },
        start() {
            if (started) return;
            started = true;
            for (const providerId of entries.keys()) {
                const name = `provider-usage:${providerId}`;
                // A poll never throws, so the loop's own backoff stays idle and
                // the schedule is exactly the interval.
                const loop = forever(
                    { name, delay: intervalMs, signal: options.shutdown.signal },
                    async () => {
                        await poll(providerId);
                    },
                );
                options.shutdown.register(name, () => loop);
            }
        },
    };
}
