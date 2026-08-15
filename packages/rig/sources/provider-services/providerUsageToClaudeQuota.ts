import {
    unavailableProviderQuota,
    type ProviderQuota,
    type ProviderQuotaWindow,
    type ProviderUsage,
} from "@slopus/happy-providers";

/**
 * Narrows a full Claude usage reading to the two windows a quota display
 * draws. A window without a reset time cannot be drawn as a countdown, so it
 * is reported as unavailable rather than as a bar that never empties.
 */
export function providerUsageToClaudeQuota(
    usage: ProviderUsage | null,
    capturedAt: number,
): ProviderQuota {
    if (usage === null) return unavailableProviderQuota("claude", capturedAt);
    return {
        capturedAt: usage.capturedAt,
        source: "claude",
        windows: {
            fiveHour: providerUsageWindowToQuota(usage.windows.fiveHour, usage.capturedAt),
            weekly: providerUsageWindowToQuota(usage.windows.weekly, usage.capturedAt),
        },
    };
}

function providerUsageWindowToQuota(
    window: ProviderUsage["windows"]["fiveHour"],
    capturedAt: number,
): ProviderQuotaWindow {
    if (window === null || window.resetsAt === null) {
        return { status: "unavailable" };
    }
    return {
        capturedAt,
        status: "available",
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        ...(window.durationMs === null ? {} : { durationMs: window.durationMs }),
    };
}
