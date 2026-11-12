/**
 * Usage: what was consumed, never summarized across models.
 *
 * Tokens from different models are not comparable quantities, so the breakdown
 * is always by provider and then by model; a client wanting a rollup computes
 * its own.
 */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable } from "./common.js";
import { providerModelReferenceSchema, providerPoolSchema } from "./daemon.js";

/** Token counts for one model. */
export interface ModelUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Provider key, then model ID, then the counts. */
export type UsageBreakdown = Record<string, Record<string, ModelUsage>>;

/** One normalized account-usage window reported by a provider. */
export const providerAccountUsageWindowSchema = Type.Object({
    usedPercent: Type.Number(),
    resetsAt: Nullable(Type.Number()),
    startsAt: Nullable(Type.Number()),
    durationMs: Nullable(Type.Number()),
    /** When this window itself was last measured, protocol 29 or newer. */
    capturedAt: Type.Optional(Type.Number()),
});
export type ProviderAccountUsageWindow = Static<typeof providerAccountUsageWindowSchema>;

/** Spendable balance reported alongside a provider's account limits. */
export const providerAccountUsageCreditsSchema = Type.Object({
    available: Type.Boolean(),
    remainingCents: Nullable(Type.Number()),
    unlimited: Type.Boolean(),
    usedPercent: Nullable(Type.Number()),
});
export type ProviderAccountUsageCredits = Static<typeof providerAccountUsageCreditsSchema>;

/** The complete latest normalized account-usage reading from one vendor. */
export const providerAccountUsageSchema = Type.Object({
    providerId: Type.String(),
    vendor: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]),
    capturedAt: Type.Number(),
    planName: Nullable(Type.String()),
    exhausted: Type.Boolean(),
    windows: Type.Object({
        fiveHour: Nullable(providerAccountUsageWindowSchema),
        weekly: Nullable(providerAccountUsageWindowSchema),
        monthly: Nullable(providerAccountUsageWindowSchema),
        /** Claude's separate weekly Fable allowance. Omitted or null when unreported. */
        fableWeekly: Type.Optional(Nullable(providerAccountUsageWindowSchema)),
    }),
    credits: Nullable(providerAccountUsageCreditsSchema),
});
export type ProviderAccountUsage = Static<typeof providerAccountUsageSchema>;

/**
 * An account's sign-in as the daemon last learned it. `signed_out` follows the `signin_missing`
 * rule; `unknown` means nothing has told since the daemon started.
 */
export const providerAccountSignInSchema = Type.Union([
    Type.Literal("signed_in"),
    Type.Literal("signed_out"),
    Type.Literal("unknown"),
]);
export type ProviderAccountSignIn = Static<typeof providerAccountSignInSchema>;

const providerAccountSignInFieldSchema = Type.Object({
    /** Absent for a smart provider and from older daemons; clients treat absent as `unknown`. */
    signIn: Type.Optional(providerAccountSignInSchema),
});

const providerAccountReadStateSchema = Type.Object({
    providerId: Type.String(),
    /** The latest successful normalized reading, or `null` when none is available. */
    usage: Nullable(providerAccountUsageSchema),
    /** When the daemon last finished asking, successfully or not. */
    checkedAt: Nullable(Type.Number()),
    /** Why no reading is available at all. */
    error: Nullable(Type.String()),
    /** When the last successful reading arrived, from a poll or from inference. */
    refreshedAt: Type.Optional(Nullable(Type.Number())),
    /** Why the latest read failed, kept even while an older reading is shown. */
    refreshError: Type.Optional(Nullable(Type.String())),
    /** The instant before which the vendor asked not to be asked again. */
    retryAt: Type.Optional(Nullable(Type.Number())),
    /** Whether a read of this account is in flight. */
    refreshing: Type.Optional(Type.Boolean()),
});

/**
 * Everything the daemon knows about reading one provider account, without its configuration.
 *
 * The refresh fields are optional only for compatibility with older daemons: a protocol-29 daemon
 * always sends them, so an entry without `refreshedAt` comes from a daemon that neither publishes
 * `provider.usage.updated` nor serves `POST /v0/usage/refresh`.
 */
export const providerAccountUsageStateSchema = Type.Composite([
    providerAccountReadStateSchema,
    providerAccountSignInFieldSchema,
]);
export type ProviderAccountUsageState = Static<typeof providerAccountUsageStateSchema>;

/**
 * The `provider.usage.updated` payload: every read-state field is always sent, while `signIn` stays
 * optional because smart providers and older daemons omit it.
 */
export const providerAccountUsageSnapshotSchema = Type.Composite([
    Type.Required(providerAccountReadStateSchema),
    providerAccountSignInFieldSchema,
]);

/** One configured provider, its complete model catalog, and its latest account limits. */
export const providerUsageEntrySchema = Type.Composite([
    providerAccountUsageStateSchema,
    Type.Object({
        /** The canonical provider key from the effective configuration. */
        type: Type.String(),
        enabled: Type.Boolean(),
        /** The same complete model-reference list returned for this provider by `GET /v0/config`. */
        models: Type.Array(providerModelReferenceSchema),
        /** A smart provider's members, exactly as on its `GET /v0/config` entry. */
        pool: Type.Optional(providerPoolSchema),
    }),
]);
export type ProviderUsageEntry = Static<typeof providerUsageEntrySchema>;

/** `POST /v0/usage/refresh` request body, protocol 29 or newer. */
export const providerUsageRefreshRequestSchema = Type.Object(
    {
        /** The accounts to consider; every enabled account when omitted. */
        providerIds: Type.Optional(Type.Array(Type.String())),
        /** Read only accounts older than this; defaults to 300000 and is at least 60000. */
        olderThanMs: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
);
export type ProviderUsageRefreshRequest = Static<typeof providerUsageRefreshRequestSchema>;

/** `POST /v0/usage/refresh` — `202`; the results arrive as `provider.usage.updated`. */
export const providerUsageRefreshResponseSchema = Type.Object({
    started: Type.Array(Type.String()),
});
export type ProviderUsageRefreshResponse = Static<typeof providerUsageRefreshResponseSchema>;

/** `GET /v0/usage/daily` query; served when health reports `capabilities.dailyUsage`. */
export const dailyUsageQuerySchema = Type.Object(
    {
        /** Days to report, ending with today: 1 to 1,096. The daemon defaults to 365. */
        days: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_096 })),
        /** IANA time zone whose calendar days are reported. The daemon defaults to `UTC`. */
        tz: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type DailyUsageQuery = Static<typeof dailyUsageQuerySchema>;

const calendarDateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const modelUsageSchema = Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
});

/** One calendar day with usage, broken down by provider and then by model. */
export const dailyUsageDaySchema = Type.Object({
    date: calendarDateSchema,
    byProvider: Type.Record(Type.String(), Type.Record(Type.String(), modelUsageSchema)),
});
export type DailyUsageDay = Static<typeof dailyUsageDaySchema>;

/** `GET /v0/usage/daily` — only days with usage, ascending; `since` is the first ever. */
export const dailyUsageResponseSchema = Type.Object({
    days: Type.Array(dailyUsageDaySchema),
    since: Nullable(calendarDateSchema),
});
export type DailyUsageResponse = Static<typeof dailyUsageResponseSchema>;

/** The latest exact provider measurement of one agent's active conversation context. */
export interface AgentContextUsage {
    approximate: boolean;
    contextTokens: number;
    /** The configured hard limit, or `null` for a custom model with no known limit. */
    contextWindow: number | null;
    modelId: string | null;
    providerId: string;
}

/** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
export interface AgentUsageResponse {
    /** The root agent's current context; descendant contexts are deliberately separate. */
    context: AgentContextUsage | null;
    usage: UsageBreakdown;
}

/** `GET /v0/usage` — rolling windows ending now. */
export interface DaemonUsageResponse {
    /** Optional only so this client remains compatible with older protocol-22 daemons. */
    providers?: ProviderUsageEntry[];
    hour: UsageBreakdown;
    day: UsageBreakdown;
    week: UsageBreakdown;
    month: UsageBreakdown;
}
