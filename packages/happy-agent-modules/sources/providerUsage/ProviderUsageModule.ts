import type { AgentModule } from "@slopus/happy-agent-base";
import {
    ProviderUsageRequestError,
    type ProviderUsage,
    type ProviderUsageWindow,
} from "@slopus/happy-providers";
import {
    asyncQueue,
    forever,
    isAbortedError,
    type AsyncQueue,
    type Context,
} from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";

export const PROVIDER_USAGE_POLL_INTERVAL_MS = 15 * 60 * 1_000;

export interface ProviderUsageEntry {
    readonly providerId: string;
    readonly usage: ProviderUsage | null;
    readonly checkedAt: number | null;
    readonly error: string | null;
}

/** Keeps the latest advisory account-usage reading for every configured provider in memory. */
export class ProviderUsageModule implements AgentModule {
    readonly name = "providerUsage";

    readonly #config: ConfigModule;
    readonly #entries: Map<string, ProviderUsageEntry>;
    readonly #queues: Map<string, AsyncQueue>;
    readonly #loops: Promise<void>[] = [];
    /** When a provider asked to not be called again until some instant, per its own 429. */
    readonly #retryAfter = new Map<string, number>();
    #unsubscribe: (() => void) | undefined;
    #started = false;

    constructor(config: ConfigModule) {
        this.#config = config;
        const providerIds = Object.keys(config.configuration.values.providers);
        this.#entries = new Map(
            providerIds.map((providerId) => [
                providerId,
                { providerId, usage: null, checkedAt: null, error: null },
            ]),
        );
        this.#queues = new Map(providerIds.map((providerId) => [providerId, asyncQueue()]));
    }

    readonly beforeStart = (ctx: Context): void => {
        if (this.#started) return;
        this.#started = true;
        // A vendor that measures the account on every response is the better source: the reading
        // is current, it costs nothing, and it cannot be rate limited. Polling remains for the
        // cold start and for vendors that only answer when asked.
        this.#unsubscribe = this.#config.onProviderAccountUsage((usage) => {
            this.#observe(usage);
        });
        for (const providerId of this.#entries.keys()) {
            const name = `provider-usage:${providerId}`;
            const loop = forever(
                ctx,
                { delay: PROVIDER_USAGE_POLL_INTERVAL_MS, delayFirst: false, name },
                async (pollCtx) => {
                    await this.refresh(pollCtx, providerId);
                },
            ).catch((error: unknown) => {
                if (!isAbortedError(error)) {
                    ctx.log.warn(`Provider usage polling stopped for "${providerId}".`, {}, error);
                }
            });
            this.#loops.push(loop);
        }
    };

    /** Every configured provider, including accounts that have never produced a reading. */
    list(): readonly ProviderUsageEntry[] {
        return [...this.#entries.values()].map((entry) => ({
            ...entry,
            usage: entry.usage === null ? null : structuredClone(entry.usage),
        }));
    }

    /**
     * Record a reading a provider volunteered during inference.
     *
     * Such a reading is deliberately partial — a vendor reports the window that currently
     * constrains the account and stays silent about the rest — so it is merged onto what is
     * already known rather than replacing it and erasing a window nobody asked about.
     */
    #observe(usage: ProviderUsage): void {
        const previous = this.#entries.get(usage.providerId);
        // A reading from an account this installation does not have configured is not ours.
        if (previous === undefined) return;
        const now = Date.now();
        this.#entries.set(usage.providerId, {
            providerId: usage.providerId,
            usage: mergeProviderUsage(previous.usage, usage, now),
            checkedAt: now,
            error: null,
        });
    }

    /** Ask one provider now; concurrent scheduled and direct reads remain serialized per account. */
    async refresh(ctx: Context, providerId: string): Promise<ProviderUsageEntry | undefined> {
        const queue = this.#queues.get(providerId);
        if (queue === undefined) return undefined;
        return await queue.runInLock(ctx, async () => {
            const previous = this.#entries.get(providerId);
            if (previous === undefined) return undefined;
            // The provider named the instant it will answer again. Asking sooner earns another
            // refusal and nothing else, so the poll is skipped until then.
            const retryAt = this.#retryAfter.get(providerId);
            if (retryAt !== undefined && Date.now() < retryAt) return previous;
            try {
                const usage = await this.#config.readProviderUsage(ctx, providerId);
                this.#retryAfter.delete(providerId);
                // A poll answers about every window, so it supersedes the partial readings that
                // arrived in band. What it does not report, it genuinely does not know.
                const entry: ProviderUsageEntry = {
                    providerId,
                    usage: usage ?? previous.usage,
                    checkedAt: Date.now(),
                    error:
                        usage === null && previous.usage === null
                            ? "The provider did not report account usage."
                            : null,
                };
                this.#entries.set(providerId, entry);
                return entry;
            } catch (error: unknown) {
                if (ctx.lifetime?.aborted === true) return previous;
                if (error instanceof ProviderUsageRequestError && error.retryAt !== undefined) {
                    this.#retryAfter.set(providerId, error.retryAt);
                }
                const entry: ProviderUsageEntry = {
                    providerId,
                    usage: previous.usage,
                    checkedAt: Date.now(),
                    error:
                        previous.usage === null
                            ? error instanceof Error
                                ? error.message
                                : String(error)
                            : null,
                };
                this.#entries.set(providerId, entry);
                ctx.log.warn(
                    `Could not read account usage for provider "${providerId}".`,
                    {},
                    error,
                );
                return entry;
            }
        });
    }

    /** Wait for every named polling loop to observe runtime cancellation. */
    async close(): Promise<void> {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        await Promise.allSettled(this.#loops);
    }
}

/**
 * Lay a newer reading over an older one without losing what the newer one is silent about.
 *
 * A vendor reporting in band names only the window that currently constrains the account, so a
 * missing window means "not mentioned", not "no longer limited". Anything the new reading does
 * state wins, including the states that are meaningful when false.
 */
function mergeProviderUsage(
    previous: ProviderUsage | null,
    next: ProviderUsage,
    now: number,
): ProviderUsage {
    if (previous === null) return next;
    const carried = (
        current: ProviderUsageWindow | null,
        older: ProviderUsageWindow | null,
    ): ProviderUsageWindow | null => {
        if (current !== null) return current;
        // A window the newer reading did not mention is only worth keeping while it is still the
        // window it described. Once it has reset, its percentage measures a period that is over,
        // and reporting it as current would be worse than reporting nothing.
        if (older === null || (older.resetsAt !== null && older.resetsAt <= now)) return null;
        return older;
    };
    return {
        ...next,
        planName: next.planName ?? previous.planName,
        windows: {
            fiveHour: carried(next.windows.fiveHour, previous.windows.fiveHour),
            weekly: carried(next.windows.weekly, previous.windows.weekly),
            monthly: carried(next.windows.monthly, previous.windows.monthly),
            ...carryNamedWindow(next.windows, previous.windows, "fableWeekly", carried),
        },
        credits: next.credits ?? previous.credits,
    };
}

function carryNamedWindow(
    next: ProviderUsage["windows"],
    previous: ProviderUsage["windows"],
    key: string,
    carried: (
        current: ProviderUsageWindow | null,
        older: ProviderUsageWindow | null,
    ) => ProviderUsageWindow | null,
): Record<string, ProviderUsageWindow | null> {
    const windows = (usage: ProviderUsage["windows"]): Record<string, ProviderUsageWindow | null> =>
        usage as Record<string, ProviderUsageWindow | null>;
    const current = windows(next)[key] ?? null;
    const older = windows(previous)[key] ?? null;
    const value = carried(current, older);
    if (
        value === null &&
        windows(next)[key] === undefined &&
        windows(previous)[key] === undefined
    ) {
        return {};
    }
    return { [key]: value };
}
