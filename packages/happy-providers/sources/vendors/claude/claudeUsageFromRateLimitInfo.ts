import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderUsage, ProviderUsageCredits } from "@/core/ProviderUsage.js";
import { epochMsFromSeconds, providerUsageWindow } from "@/core/providerUsageValues.js";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Reads the rate-limit report the Claude SDK already emits during inference.
 *
 * This is the same account-wide unified limiter the response headers carry, so
 * every ordinary run tells us where the account stands and nothing has to ask
 * the vendor a second time. It reports only the single window that currently
 * constrains the account, which is why the reading is deliberately partial:
 * an unreported window is null and the caller keeps whatever it already knew.
 *
 * Returns null when the report says nothing worth recording.
 */
export function claudeUsageFromRateLimitInfo(
    info: SDKRateLimitInfo,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    // Overage and other model-scoped windows stay unread, except Fable's
    // weekly allowance, which is its own meter the account actually spends.
    const key =
        info.rateLimitType === "five_hour"
            ? "fiveHour"
            : info.rateLimitType === "seven_day"
              ? "weekly"
              : info.rateLimitType === "seven_day_fable"
                ? "fableWeekly"
                : null;
    const resetsAt = epochMsFromSeconds(info.resetsAt);
    const durationMs = key === "fiveHour" ? FIVE_HOUR_MS : SEVEN_DAY_MS;
    const window =
        key === null
            ? null
            : providerUsageWindow({
                  // The limiter reports a fraction of the limit, where the OAuth
                  // usage endpoint already reports a percentage.
                  usedPercent: info.utilization === undefined ? undefined : info.utilization * 100,
                  resetsAt,
                  startsAt: resetsAt === null ? null : resetsAt - durationMs,
                  durationMs,
              });
    const credits = parseOverageCredits(info);
    const rejected = info.status === "rejected";
    // An allowed account with no measured window has told us nothing new.
    if (window === null && credits === null && !rejected) return null;

    return {
        providerId: context.providerId,
        vendor: "claude",
        capturedAt: context.capturedAt,
        planName: null,
        exhausted: rejected && credits?.available !== true,
        windows: {
            fiveHour: key === "fiveHour" ? window : null,
            weekly: key === "weekly" ? window : null,
            monthly: null,
            fableWeekly: key === "fableWeekly" ? window : null,
        },
        credits,
    };
}

/**
 * Overage is Anthropic's pay-past-the-limit credit. It is only spendable when
 * the account is actually allowed to use it.
 */
function parseOverageCredits(info: SDKRateLimitInfo): ProviderUsageCredits | null {
    if (info.overageStatus === undefined) return null;
    return {
        available: info.overageStatus !== "rejected",
        remainingCents: null,
        unlimited: false,
        usedPercent: null,
    };
}
