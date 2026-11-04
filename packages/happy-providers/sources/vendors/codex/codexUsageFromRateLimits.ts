import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ProviderUsage, ProviderUsageCredits } from "@/core/ProviderUsage.js";
import { providerPlanName } from "@/core/providerUsageValues.js";
import {
    parseCodexCredits,
    parseCodexWindows,
    type CodexWindowPayload,
} from "@/vendors/codex/fetchCodexProviderUsage.js";

/** The limit Codex's own account windows are reported under; other metered limits are not it. */
const CODEX_LIMIT_NAME = "codex";
const HEADER_PREFIX = `x-${CODEX_LIMIT_NAME}-`;

/**
 * The `codex.rate_limits` event the ChatGPT backend sends before every WebSocket response. The
 * shape follows upstream Codex's `RateLimitEvent`: windows carry a percentage, their length in
 * minutes, and their reset in epoch seconds. Nothing here is trusted beyond what is checked.
 */
const rateLimitWindowSchema = Type.Object({
    used_percent: Type.Number(),
    window_minutes: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    reset_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

const rateLimitEventSchema = Type.Object({
    type: Type.Literal("codex.rate_limits"),
    plan_type: Type.Optional(Type.Unknown()),
    rate_limits: Type.Optional(
        Type.Union([
            Type.Object({
                primary: Type.Optional(Type.Unknown()),
                secondary: Type.Optional(Type.Unknown()),
            }),
            Type.Null(),
        ]),
    ),
    credits: Type.Optional(Type.Unknown()),
    metered_limit_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    limit_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/**
 * Reads the account windows Codex reports in band on a WebSocket response.
 *
 * Returns null for any other event, for a report about a different metered limit, and for a
 * report that measured nothing.
 */
export function codexUsageFromRateLimitEvent(
    event: unknown,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    if (!Value.Check(rateLimitEventSchema, event)) return null;
    const limitName = event.metered_limit_name ?? event.limit_name ?? CODEX_LIMIT_NAME;
    if (limitName.toLowerCase() !== CODEX_LIMIT_NAME) return null;
    const windows = parseCodexWindows([
        eventWindow(event.rate_limits?.primary),
        eventWindow(event.rate_limits?.secondary),
    ]);
    const credits = parseCodexCredits(
        typeof event.credits === "object" && event.credits !== null
            ? (event.credits as Parameters<typeof parseCodexCredits>[0])
            : null,
    );
    return codexUsage(windows, credits, providerPlanName(event.plan_type), context);
}

const appServerWindowSchema = Type.Union([
    Type.Object({
        usedPercent: Type.Number(),
        windowDurationMins: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        resetsAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    }),
    Type.Null(),
]);

/** The rate-limit snapshot `codex app-server` sends in `account/rateLimits/updated`. */
const appServerRateLimitsSchema = Type.Object({
    limitId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    primary: Type.Optional(appServerWindowSchema),
    secondary: Type.Optional(appServerWindowSchema),
    credits: Type.Optional(
        Type.Union([
            Type.Object({
                hasCredits: Type.Boolean(),
                unlimited: Type.Boolean(),
                balance: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
        ]),
    ),
    planType: Type.Optional(Type.Unknown()),
});

/**
 * Reads the same account windows from the snapshot `codex app-server` reports. Returns null for a
 * report about a different metered limit and for one that measured nothing.
 */
export function codexUsageFromAppServerRateLimits(
    rateLimits: unknown,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    if (!Value.Check(appServerRateLimitsSchema, rateLimits)) return null;
    if ((rateLimits.limitId ?? CODEX_LIMIT_NAME).toLowerCase() !== CODEX_LIMIT_NAME) return null;
    const window = (value: Static<typeof appServerWindowSchema> | undefined) =>
        value == null
            ? null
            : windowPayload(value.usedPercent, value.windowDurationMins, value.resetsAt);
    const credits = rateLimits.credits;
    return codexUsage(
        parseCodexWindows([window(rateLimits.primary), window(rateLimits.secondary)]),
        credits == null
            ? null
            : parseCodexCredits({
                  has_credits: credits.hasCredits,
                  unlimited: credits.unlimited,
                  balance: credits.balance ?? undefined,
              }),
        providerPlanName(rateLimits.planType),
        context,
    );
}

/**
 * Reads the same account windows from the `x-codex-*` headers the backend attaches to an SSE
 * response. Returns null when the response carries none, as API-key and Bedrock traffic does.
 */
export function codexUsageFromRateLimitHeaders(
    headers: Headers,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    const windows = parseCodexWindows([
        headerWindow(headers, "primary"),
        headerWindow(headers, "secondary"),
    ]);
    const hasCredits = headers.get(`${HEADER_PREFIX}credits-has-credits`);
    const credits =
        hasCredits === null
            ? null
            : parseCodexCredits({
                  has_credits: hasCredits.toLowerCase() === "true",
                  unlimited:
                      headers.get(`${HEADER_PREFIX}credits-unlimited`)?.toLowerCase() === "true",
                  balance: headers.get(`${HEADER_PREFIX}credits-balance`) ?? undefined,
              });
    return codexUsage(windows, credits, null, context);
}

function codexUsage(
    windows: ProviderUsage["windows"],
    credits: ProviderUsageCredits | null,
    planName: string | null,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    const measured = [windows.fiveHour, windows.weekly, windows.monthly];
    if (measured.every((window) => window === null) && credits === null) return null;
    return {
        providerId: context.providerId,
        vendor: "codex",
        capturedAt: context.capturedAt,
        planName,
        // Credits outlive a spent window, exactly as the usage endpoint reports them.
        exhausted:
            measured.some((window) => window !== null && window.usedPercent >= 100) &&
            credits?.available !== true,
        windows,
        credits,
    };
}

function eventWindow(value: unknown): CodexWindowPayload | null {
    if (!Value.Check(rateLimitWindowSchema, value)) return null;
    return windowPayload(value.used_percent, value.window_minutes, value.reset_at);
}

function headerWindow(headers: Headers, name: "primary" | "secondary"): CodexWindowPayload | null {
    const used = headers.get(`${HEADER_PREFIX}${name}-used-percent`);
    if (used === null) return null;
    const minutes = headers.get(`${HEADER_PREFIX}${name}-window-minutes`);
    const resetAt = headers.get(`${HEADER_PREFIX}${name}-reset-at`);
    return windowPayload(
        Number(used),
        minutes === null ? null : Number(minutes),
        resetAt === null ? null : Number(resetAt),
    );
}

function windowPayload(
    usedPercent: number,
    windowMinutes: number | null | undefined,
    resetAt: number | null | undefined,
): CodexWindowPayload {
    return {
        used_percent: Math.min(100, usedPercent),
        limit_window_seconds:
            typeof windowMinutes === "number" && Number.isFinite(windowMinutes)
                ? windowMinutes * 60
                : undefined,
        reset_at: resetAt ?? undefined,
    };
}
