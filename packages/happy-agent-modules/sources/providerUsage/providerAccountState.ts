import type { ProviderUsage, ProviderUsageWindow } from "@slopus/happy-providers";

/**
 * Where an account stands, judged only from the vendor's latest reading and the clock.
 *
 * - `measured`: no full window stands in the way, so the reading is what the vendor last said.
 * - `blocked`: a full window resets at `resetsAt`, and nothing about the account can change
 *   before then.
 * - `resetPassed`: the full window that blocked the account reset at `resetAt`, and no vendor
 *   reading since has said where the account stands now. The old numbers are not current, and
 *   the account is not known to work either.
 */
export type ProviderAccountState =
    | { readonly kind: "measured" }
    | { readonly kind: "blocked"; readonly resetsAt: number }
    | { readonly kind: "resetPassed"; readonly resetAt: number };

/**
 * The state of the account whose latest reading is `usage`.
 *
 * With several full windows the account works again only once the last one resets, so it stays
 * blocked until then. A full window still on the reading after its reset has not been measured
 * since; a vendor that measured it again either names the next reset or reports it no longer
 * full. An exhausted account whose full window is unknown has no reset to wait for and counts as
 * measured.
 */
export function providerAccountState(
    usage: ProviderUsage | null,
    now: number,
): ProviderAccountState {
    if (usage === null) return { kind: "measured" };
    let resetAt: number | null = null;
    for (const window of windowsOf(usage)) {
        if (window === null || window.usedPercent < 100 || window.resetsAt === null) continue;
        resetAt = Math.max(resetAt ?? window.resetsAt, window.resetsAt);
    }
    if (resetAt === null) return { kind: "measured" };
    return resetAt > now
        ? { kind: "blocked", resetsAt: resetAt }
        : { kind: "resetPassed", resetAt };
}

export function windowsOf(usage: ProviderUsage): (ProviderUsageWindow | null)[] {
    const extra = usage.windows as Record<string, ProviderUsageWindow | null | undefined>;
    return [
        usage.windows.fiveHour,
        usage.windows.weekly,
        usage.windows.monthly,
        usage.windows.fableWeekly ?? null,
        extra["claudeGptFiveHour"] ?? null,
        extra["claudeGptWeekly"] ?? null,
    ];
}
