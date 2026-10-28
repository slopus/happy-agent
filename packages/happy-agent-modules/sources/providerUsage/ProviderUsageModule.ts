import type { AgentModule } from "@slopus/happy-agent-base";
import {
    ProviderUsageRequestError,
    type ClaudeUsageEndpointRefusal,
    type ProviderUsage,
    type ProviderUsageWindow,
} from "@slopus/happy-providers";
import {
    asyncQueue,
    detach,
    forever,
    isAbortedError,
    withLifetime,
    type AsyncQueue,
    type Context,
} from "@steve.kite/stdlib";

import { ConfigModule, type ProviderSignInObservation } from "../config/index.js";

/** A spent-usage refusal older than this no longer says the account is spent. */
const SPENT_READING_MAX_AGE_MS = 15 * 60_000;
/** How often every account is asked in the background, after the read at startup. */
export const PROVIDER_USAGE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** How old a reading must be before a client's refresh request reads it again, by default. */
export const PROVIDER_USAGE_REFRESH_DEFAULT_AGE_MS = 5 * 60 * 1_000;
/** The freshest a client may demand, so a refresh cannot hammer a rate-limited vendor API. */
export const PROVIDER_USAGE_REFRESH_MINIMUM_AGE_MS = 60 * 1_000;
/** How long after a blocking window resets the account is read again. */
export const PROVIDER_USAGE_RESET_RECHECK_DELAY_MS = 30 * 1_000;
/** The waits between reads while an account still reads blocked after its reset passed. */
export const PROVIDER_USAGE_RESET_RECHECK_BACKOFF_MS: readonly number[] = [
    60 * 1_000,
    2 * 60 * 1_000,
    5 * 60 * 1_000,
];
/** After this many reads past the reset the daily poll and in-band readings take over again. */
export const PROVIDER_USAGE_RESET_RECHECK_ATTEMPTS = 6;

const NOT_REPORTED = "The provider did not report account usage.";
/** How long a read that returned nothing may spend looking for the account's credential locally. */
const CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

/** An account's sign-in as the daemon last learned it; `unknown` until something tells. */
export type ProviderAccountSignIn = ProviderSignInObservation | "unknown";

export interface ProviderUsageEntry {
    readonly providerId: string;
    readonly usage: ProviderUsage | null;
    /** When the daemon last finished asking, successfully or not. */
    readonly checkedAt: number | null;
    /** Why no reading is available at all. */
    readonly error: string | null;
    /** When the last successful reading arrived, from a poll or from inference. */
    readonly refreshedAt: number | null;
    /** Why the latest read failed, kept while an older reading is still shown. */
    readonly refreshError: string | null;
    /** The instant before which the vendor asked not to be asked again. */
    readonly retryAt: number | null;
    /** Whether a read of this account is in flight. */
    readonly refreshing: boolean;
    /** The account's sign-in; absent for a smart provider, which is not an account. */
    readonly signIn?: ProviderAccountSignIn;
}

export interface ProviderUsageRefreshOptions {
    /** The accounts to consider; every account when omitted. */
    readonly providerIds?: readonly string[];
    /** Read only accounts whose reading is older than this. */
    readonly olderThanMs?: number;
}

/** One pending read scheduled for just after the window blocking an account resets. */
interface ResetRecheck {
    /** The reset instant this recheck waits for. */
    readonly resetAt: number;
    /** Reads already made past that reset that still found the account blocked. */
    readonly attempt: number;
    readonly timer: ReturnType<typeof setTimeout> | undefined;
    /** Set while the recheck's own read runs, so the readings it causes do not reschedule it. */
    readonly running: boolean;
}

/** Keeps the latest advisory account-usage reading for every configured provider in memory. */
export class ProviderUsageModule implements AgentModule {
    readonly name = "providerUsage";

    readonly #config: ConfigModule;
    readonly #entries: Map<string, ProviderUsageEntry>;
    readonly #queues: Map<string, AsyncQueue>;
    readonly #listeners = new Set<(entry: ProviderUsageEntry) => void>();
    readonly #loops: Promise<void>[] = [];
    /** Reads started on a client's behalf or by a recheck, awaited on close. */
    readonly #background = new Set<Promise<unknown>>();
    /** Accounts with a read queued or running, so a refresh request does not pile reads up. */
    readonly #busy = new Map<string, number>();
    /** Accounts whose OAuth usage endpoint refused their token; the configuration is fixed. */
    readonly #endpointRefused = new Set<string>();
    /** Accounts whose OAuth usage endpoint throttled us, until the instant it named. */
    readonly #endpointRetryAt = new Map<string, number>();
    /** A separate budget for actual fallback inference, including successful probes. */
    readonly #probes = new Map<string, { attempts: number; nextAt: number }>();
    readonly #rechecks = new Map<string, ResetRecheck>();
    /** When inference last reported each account refused, which a windowless reading cannot date. */
    readonly #refusedAt = new Map<string, number>();
    readonly #closing = new AbortController();
    #backgroundContext: Context | undefined;
    readonly #unsubscribe: (() => void)[] = [];
    #started = false;
    #closed = false;

    constructor(config: ConfigModule) {
        this.#config = config;
        const providerIds = Object.keys(config.configuration.values.providers);
        this.#entries = new Map(
            providerIds.map((providerId) => [
                providerId,
                {
                    providerId,
                    usage: null,
                    checkedAt: null,
                    error: null,
                    refreshedAt: null,
                    refreshError: null,
                    retryAt: null,
                    refreshing: false,
                    ...(config.configuration.values.providers[providerId]?.type === "smart"
                        ? {}
                        : { signIn: "unknown" as const }),
                },
            ]),
        );
        this.#queues = new Map(providerIds.map((providerId) => [providerId, asyncQueue()]));
    }

    readonly beforeStart = (ctx: Context): void => {
        if (this.#started) return;
        this.#started = true;
        this.#backgroundContext = this.#ownContext(ctx);
        // A vendor that measures the account on every response is the better source: the reading
        // is current, it costs nothing, and it cannot be rate limited. Polling remains for the
        // cold start and for vendors that only answer when asked.
        this.#unsubscribe.push(
            this.#config.onProviderAccountUsage((usage) => {
                this.#observe(usage);
            }),
            // Inference and credential discovery say whether the vendor accepts an account, which
            // no usage reading may arrive to prove.
            this.#config.onProviderSignIn((providerId, signIn) => {
                this.#observeSignIn(providerId, signIn);
            }),
        );
        // The loops end with the runtime or with this module, whichever closes first.
        const loopCtx = withLifetime(ctx, this.#lifetime(ctx));
        for (const providerId of this.#entries.keys()) {
            const name = `provider-usage:${providerId}`;
            const loop = forever(
                loopCtx,
                { delay: PROVIDER_USAGE_POLL_INTERVAL_MS, delayFirst: false, name },
                async (pollCtx) => {
                    await this.refresh(pollCtx, providerId, {
                        olderThanMs: PROVIDER_USAGE_POLL_INTERVAL_MS,
                    });
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
     * When the first of these accounts that a full usage window blocks works again, which is when
     * a pool of them has an account to offer. Null when none of them reports such a reset.
     */
    firstBlockedReset(providerIds: readonly string[]): number | null {
        let first: number | null = null;
        for (const providerId of providerIds) {
            const entry = this.#entries.get(providerId);
            const resetAt = entry === undefined ? null : blockingResetAt(entry.usage);
            if (resetAt !== null) first = Math.min(first ?? resetAt, resetAt);
        }
        return first;
    }

    /**
     * Whether the vendor said within the last fifteen minutes that it refuses this account because
     * its usage is spent, and when the window blocking it resets (null when unknown). Undefined
     * when the account is not known to be spent, including once that window has reset.
     */
    spentAccount(providerId: string): { readonly resetsAt: number | null } | undefined {
        const usage = this.#entries.get(providerId)?.usage;
        if (usage === undefined || usage === null || !usage.exhausted) return undefined;
        const now = Date.now();
        // A refusal carrying no window keeps the reading's older capture time, so it is dated by
        // when inference reported it instead.
        const saidAt = Math.max(usage.capturedAt, this.#refusedAt.get(providerId) ?? 0);
        const resetsAt = blockingResetAt(usage);
        if (now - saidAt > SPENT_READING_MAX_AGE_MS || (resetsAt !== null && resetsAt <= now)) {
            return undefined;
        }
        return { resetsAt };
    }

    /**
     * Observes every change to an entry — a read starting or finishing, an in-band reading, a
     * failure — in the order the changes happened, so consumers can republish them immediately.
     */
    onChanged(listener: (entry: ProviderUsageEntry) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Start background reads of the accounts whose readings are older than `olderThanMs`.
     *
     * Returns at once with the accounts whose reads started, in configuration order. Accounts
     * without a usage source, under the vendor's retry deadline, already being read, or fresh
     * enough are skipped. The readings arrive through `onChanged`.
     */
    requestRefresh(ctx: Context, options: ProviderUsageRefreshOptions = {}): string[] {
        if (this.#closed) return [];
        const olderThanMs = Math.max(
            PROVIDER_USAGE_REFRESH_MINIMUM_AGE_MS,
            options.olderThanMs ?? PROVIDER_USAGE_REFRESH_DEFAULT_AGE_MS,
        );
        const requested =
            options.providerIds === undefined ? undefined : new Set(options.providerIds);
        const background = this.#backgroundContext ?? this.#ownContext(ctx);
        const now = Date.now();
        const started: string[] = [];
        for (const entry of this.#entries.values()) {
            if (requested !== undefined && !requested.has(entry.providerId)) continue;
            if (!this.#config.hasProviderUsageSource(entry.providerId)) continue;
            if (this.#busy.has(entry.providerId)) continue;
            if (entry.retryAt !== null && now < entry.retryAt) continue;
            if (!isStale(entry, olderThanMs, now)) continue;
            started.push(entry.providerId);
            this.#track(this.refresh(background, entry.providerId, { olderThanMs }));
        }
        return started;
    }

    /**
     * Record a reading a provider volunteered during inference.
     *
     * Such a reading may be partial — a vendor can report only the window that currently
     * constrains the account and stay silent about the rest — so it is merged onto what is
     * already known rather than replacing it and erasing a window nobody asked about.
     */
    #observe(usage: ProviderUsage): void {
        const previous = this.#entries.get(usage.providerId);
        // A reading from an account this installation does not have configured is not ours.
        if (previous === undefined) return;
        const now = Date.now();
        if (usage.exhausted) this.#refusedAt.set(usage.providerId, now);
        else this.#refusedAt.delete(usage.providerId);
        const measured = measuresWindow(usage);
        if (measured)
            this.#probes.set(usage.providerId, {
                attempts: 0,
                nextAt: now + PROVIDER_USAGE_POLL_INTERVAL_MS,
            });
        this.#set({
            ...previous,
            usage: mergeProviderUsage(previous.usage, stampWindows(usage), now),
            // Only a measured window is a successful reading; a report about credits or a refusal
            // alone must not make the windows it carried forward look freshly measured.
            ...(measured ? { checkedAt: now, refreshedAt: now, refreshError: null } : {}),
            ...signedIn(previous, "signed_in"),
            error: null,
        });
    }

    /** Record what inference or credential discovery proved; an unchanged sign-in announces nothing. */
    #observeSignIn(providerId: string, signIn: ProviderSignInObservation): void {
        const previous = this.#entries.get(providerId);
        if (previous?.signIn === undefined || previous.signIn === signIn) return;
        this.#set({ ...previous, signIn });
    }

    /**
     * A read that returned nothing cannot say whether the vendor still accepts the account, but a
     * credential that is not there at all is signed out. Anything else leaves the sign-in alone.
     */
    async #signInWithoutReading(
        providerId: string,
    ): Promise<ProviderSignInObservation | undefined> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const credentials = await Promise.race([
                this.#config.probeLocalProviderCredentials(providerId),
                new Promise<undefined>((resolve) => {
                    timeout = setTimeout(() => resolve(undefined), CREDENTIAL_PROBE_TIMEOUT_MS);
                    timeout.unref?.();
                }),
            ]);
            return credentials === "missing" ? "signed_out" : undefined;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timeout);
        }
    }

    /** Ask one provider now; concurrent scheduled and direct reads remain serialized per account. */
    async refresh(
        ctx: Context,
        providerId: string,
        options: { readonly olderThanMs?: number } = {},
    ): Promise<ProviderUsageEntry | undefined> {
        const queue = this.#queues.get(providerId);
        if (queue === undefined) return undefined;
        this.#busy.set(providerId, (this.#busy.get(providerId) ?? 0) + 1);
        try {
            return await queue.runInLock(
                ctx,
                async () => await this.#read(ctx, providerId, options),
            );
        } finally {
            const remaining = (this.#busy.get(providerId) ?? 1) - 1;
            if (remaining === 0) this.#busy.delete(providerId);
            else this.#busy.set(providerId, remaining);
        }
    }

    async #read(
        ctx: Context,
        providerId: string,
        options: { readonly olderThanMs?: number },
    ): Promise<ProviderUsageEntry | undefined> {
        const previous = this.#entries.get(providerId);
        if (previous === undefined) return undefined;
        if (!this.#config.hasProviderUsageSource(providerId)) {
            // Nothing can be asked, so record that once instead of announcing it every day.
            if (previous.usage !== null || previous.error !== null) return previous;
            return this.#set({ ...previous, checkedAt: Date.now(), error: NOT_REPORTED });
        }
        // The provider named the instant it will answer again. Asking sooner earns another
        // refusal and nothing else, so the read is skipped until then.
        if (previous.retryAt !== null && Date.now() < previous.retryAt) return previous;
        // A read queued behind another one may find the account already fresh enough.
        if (
            options.olderThanMs !== undefined &&
            !isStale(previous, options.olderThanMs, Date.now())
        ) {
            return previous;
        }
        this.#set({ ...previous, refreshing: true });
        let probeDeferred = false;
        try {
            const usage = await this.#config.readProviderUsage(ctx, providerId, {
                shouldProbe: () => {
                    const admitted = this.#admitProbe(providerId);
                    probeDeferred = !admitted;
                    return admitted;
                },
                skipUsageEndpoint: this.#skipsUsageEndpoint(providerId),
                onUsageEndpointRefused: (refusal) => {
                    this.#recordEndpointRefusal(providerId, refusal);
                },
            });
            const missing =
                usage === null && !probeDeferred
                    ? await this.#signInWithoutReading(providerId)
                    : undefined;
            const current = this.#current(providerId);
            const now = Date.now();
            if (usage === null) {
                if (probeDeferred)
                    return this.#set({ ...current, checkedAt: now, refreshing: false });
                return this.#set({
                    ...current,
                    checkedAt: now,
                    error: current.usage === null ? NOT_REPORTED : null,
                    refreshError: NOT_REPORTED,
                    refreshing: false,
                    ...(missing === undefined ? {} : signedIn(current, missing)),
                });
            }
            // A poll answers about every window it can, so it supersedes the partial readings that
            // arrived in band. What it does not report, it genuinely does not know.
            const reading = stampWindows(usage);
            return this.#set({
                ...current,
                usage: {
                    ...reading,
                    planName: reading.planName ?? current.usage?.planName ?? null,
                },
                checkedAt: now,
                error: null,
                refreshedAt: now,
                refreshError: null,
                retryAt: null,
                refreshing: false,
                ...signedIn(current, "signed_in"),
            });
        } catch (error: unknown) {
            const current = this.#current(providerId);
            if (ctx.lifetime?.aborted === true) return this.#set({ ...current, refreshing: false });
            const message = error instanceof Error ? error.message : String(error);
            const retryAt =
                error instanceof ProviderUsageRequestError && error.retryAt !== undefined
                    ? error.retryAt
                    : current.retryAt;
            ctx.log.warn(`Could not read account usage for provider "${providerId}".`, {}, error);
            return this.#set({
                ...current,
                checkedAt: Date.now(),
                error: current.usage === null ? message : null,
                refreshError: message,
                retryAt,
                refreshing: false,
            });
        }
    }

    /** Each actual fallback probe grows its cooldown, even after a successful measurement. */
    #admitProbe(providerId: string): boolean {
        const now = Date.now();
        const previous = this.#probes.get(providerId);
        if (previous !== undefined && now < previous.nextAt) return false;
        const attempts = Math.min((previous?.attempts ?? 0) + 1, 4);
        const cooldown = Math.min(
            PROVIDER_USAGE_POLL_INTERVAL_MS,
            5 * 60_000 * 8 ** (attempts - 1),
        );
        this.#probes.set(providerId, { attempts, nextAt: now + cooldown });
        return true;
    }

    /** Stop every polling loop, recheck, and background read, and wait for them to finish. */
    async close(): Promise<void> {
        this.#closed = true;
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        for (const recheck of this.#rechecks.values()) clearTimeout(recheck.timer);
        this.#rechecks.clear();
        this.#closing.abort(new Error("Provider usage is shutting down."));
        await Promise.allSettled([...this.#loops, ...this.#background]);
    }

    /** Background reads belong to this module's lifetime, never to the request that asked. */
    #ownContext(ctx: Context): Context {
        return withLifetime(detach(ctx).named("provider-usage"), this.#lifetime(ctx));
    }

    #lifetime(ctx: Context): AbortSignal {
        return ctx.lifetime === undefined
            ? this.#closing.signal
            : AbortSignal.any([ctx.lifetime, this.#closing.signal]);
    }

    #track(work: Promise<unknown>): void {
        const tracked = work.catch(() => undefined).finally(() => this.#background.delete(tracked));
        this.#background.add(tracked);
    }

    #current(providerId: string): ProviderUsageEntry {
        const entry = this.#entries.get(providerId);
        if (entry === undefined) throw new Error(`Provider "${providerId}" is not configured.`);
        return entry;
    }

    #set(entry: ProviderUsageEntry): ProviderUsageEntry {
        const settled: ProviderUsageEntry =
            entry.retryAt !== null && entry.retryAt <= Date.now()
                ? { ...entry, retryAt: null }
                : entry;
        this.#entries.set(settled.providerId, settled);
        for (const listener of this.#listeners) {
            try {
                listener(settled);
            } catch {
                // A consumer republishing advisory state never decides what the account holds.
            }
        }
        if (this.#rechecks.get(settled.providerId)?.running !== true) {
            this.#reconsiderRecheck(settled.providerId);
        }
        return settled;
    }

    /** Whether this read must measure the inference headers instead of the usage endpoint. */
    #skipsUsageEndpoint(providerId: string): boolean {
        if (this.#endpointRefused.has(providerId)) return true;
        const retryAt = this.#endpointRetryAt.get(providerId);
        if (retryAt === undefined) return false;
        if (Date.now() < retryAt) return true;
        this.#endpointRetryAt.delete(providerId);
        return false;
    }

    #recordEndpointRefusal(providerId: string, refusal: ClaudeUsageEndpointRefusal): void {
        // A token the endpoint cannot read will not learn to read it; only a new configuration,
        // which means a new daemon, changes the credential.
        if (refusal.status === 403 || refusal.status === 404) this.#endpointRefused.add(providerId);
        if (refusal.status === 429 && refusal.retryAt !== undefined) {
            this.#endpointRetryAt.set(providerId, refusal.retryAt);
        }
    }

    /**
     * Keep exactly one pending read for just after the window that blocks an account resets.
     *
     * An unblocked account has none. A blocked one waits for its reset plus a short grace, or for
     * the vendor's retry deadline if that is later. A reading that names a different reset moves
     * the recheck; a reading with the same reset leaves the pending one alone.
     */
    #reconsiderRecheck(providerId: string): void {
        if (this.#closed) return;
        const entry = this.#entries.get(providerId);
        const resetAt = entry === undefined ? null : blockingResetAt(entry.usage);
        const pending = this.#rechecks.get(providerId);
        if (resetAt === null) {
            this.#cancelRecheck(providerId);
            return;
        }
        if (pending?.resetAt === resetAt) return;
        this.#scheduleRecheck(
            providerId,
            resetAt,
            0,
            resetAt + PROVIDER_USAGE_RESET_RECHECK_DELAY_MS,
        );
    }

    #scheduleRecheck(providerId: string, resetAt: number, attempt: number, at: number): void {
        this.#cancelRecheck(providerId);
        const retryAt = this.#entries.get(providerId)?.retryAt ?? null;
        const when = Math.max(at, retryAt ?? 0);
        const timer = setTimeout(
            () => {
                this.#track(this.#runRecheck(providerId));
            },
            Math.max(0, when - Date.now()),
        );
        timer.unref?.();
        this.#rechecks.set(providerId, { resetAt, attempt, timer, running: false });
    }

    #cancelRecheck(providerId: string): void {
        const pending = this.#rechecks.get(providerId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#rechecks.delete(providerId);
    }

    async #runRecheck(providerId: string): Promise<void> {
        const recheck = this.#rechecks.get(providerId);
        const ctx = this.#backgroundContext;
        if (recheck === undefined || ctx === undefined || this.#closed) return;
        if (!this.#config.hasProviderUsageSource(providerId)) {
            this.#cancelRecheck(providerId);
            return;
        }
        this.#rechecks.set(providerId, { ...recheck, timer: undefined, running: true });
        await this.refresh(ctx, providerId);
        if (this.#closed || this.#rechecks.get(providerId)?.running !== true) return;
        this.#rechecks.delete(providerId);
        const entry = this.#current(providerId);
        const resetAt = blockingResetAt(entry.usage);
        if (resetAt === null) return;
        if (resetAt !== recheck.resetAt) {
            this.#reconsiderRecheck(providerId);
            return;
        }
        // The vendor's reset can be soft: the account still reads blocked by the same window.
        const attempt = recheck.attempt + 1;
        if (attempt >= PROVIDER_USAGE_RESET_RECHECK_ATTEMPTS) {
            // Keep the reset on record so the same reading does not start the cycle over.
            this.#rechecks.set(providerId, { resetAt, attempt, timer: undefined, running: false });
            return;
        }
        const backoff =
            PROVIDER_USAGE_RESET_RECHECK_BACKOFF_MS[
                Math.min(attempt - 1, PROVIDER_USAGE_RESET_RECHECK_BACKOFF_MS.length - 1)
            ] ?? PROVIDER_USAGE_POLL_INTERVAL_MS;
        this.#scheduleRecheck(providerId, resetAt, attempt, Date.now() + backoff);
    }
}

/** The sign-in an account entry takes; a smart provider's entry carries none. */
function signedIn(
    entry: ProviderUsageEntry,
    signIn: ProviderSignInObservation,
): { readonly signIn?: ProviderAccountSignIn } {
    return entry.signIn === undefined ? {} : { signIn };
}

function isStale(entry: ProviderUsageEntry, olderThanMs: number, now: number): boolean {
    return entry.refreshedAt === null || now - entry.refreshedAt >= olderThanMs;
}

/**
 * When the window blocking an account resets, or null when nothing blocks it.
 *
 * A window at 100% blocks until it resets; an account the vendor refuses is blocked by its full
 * windows. With several full windows the account works again only once the last one resets. An
 * exhausted account whose full window is unknown has no reset to wait for, so the daily poll and
 * in-band readings remain its only rechecks.
 */
function blockingResetAt(usage: ProviderUsage | null): number | null {
    if (usage === null) return null;
    let resetAt: number | null = null;
    for (const window of windowsOf(usage)) {
        if (window === null || window.usedPercent < 100 || window.resetsAt === null) continue;
        resetAt = Math.max(resetAt ?? window.resetsAt, window.resetsAt);
    }
    return resetAt;
}

function windowsOf(usage: ProviderUsage): (ProviderUsageWindow | null)[] {
    return [
        usage.windows.fiveHour,
        usage.windows.weekly,
        usage.windows.monthly,
        usage.windows.fableWeekly ?? null,
    ];
}

function measuresWindow(usage: ProviderUsage): boolean {
    return windowsOf(usage).some((window) => window !== null);
}

/** Give every window the instant it was measured, so carrying it forward keeps its real age. */
function stampWindows(usage: ProviderUsage): ProviderUsage {
    const stamp = (window: ProviderUsageWindow | null): ProviderUsageWindow | null =>
        window === null ? null : { ...window, capturedAt: window.capturedAt ?? usage.capturedAt };
    return {
        ...usage,
        windows: {
            fiveHour: stamp(usage.windows.fiveHour),
            weekly: stamp(usage.windows.weekly),
            monthly: stamp(usage.windows.monthly),
            ...(usage.windows.fableWeekly === undefined
                ? {}
                : { fableWeekly: stamp(usage.windows.fableWeekly) }),
        },
    };
}

/**
 * Lay a newer reading over an older one without losing what the newer one is silent about.
 *
 * A vendor reporting in band may name only the window that currently constrains the account, so a
 * missing window means "not mentioned", not "no longer limited". Anything the new reading does
 * state wins, including the states that are meaningful when false. A carried window keeps its own
 * `capturedAt`, and a reading that measured no window does not move the reading's `capturedAt`.
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
        capturedAt: measuresWindow(next) ? next.capturedAt : previous.capturedAt,
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
