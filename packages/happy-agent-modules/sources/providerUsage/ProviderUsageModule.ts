import type { AgentModule } from "@slopus/happy-agent-base";
import type { ProviderUsage } from "@slopus/happy-providers";
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

    /** Ask one provider now; concurrent scheduled and direct reads remain serialized per account. */
    async refresh(ctx: Context, providerId: string): Promise<ProviderUsageEntry | undefined> {
        const queue = this.#queues.get(providerId);
        if (queue === undefined) return undefined;
        return await queue.runInLock(ctx, async () => {
            const previous = this.#entries.get(providerId);
            if (previous === undefined) return undefined;
            try {
                const usage = await this.#config.readProviderUsage(ctx, providerId);
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
        await Promise.allSettled(this.#loops);
    }
}
