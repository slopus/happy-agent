export type ProviderUsageVendor = "claude" | "codex" | "grok";

/**
 * One rate-limit or spend window a vendor reports.
 *
 * Vendors agree on the shape of a window but not on which ones exist: Codex
 * reports a rolling five-hour and weekly pair, Claude reports five-hour,
 * seven-day, and a separate Fable weekly allowance, and Grok reports a single
 * weekly or monthly billing period. A field is null when the vendor does not
 * report it, never zero.
 */
export interface ProviderUsageWindow {
    /** Share of the window already consumed, from 0 to 100. */
    usedPercent: number;
    /** Epoch milliseconds when the window resets, or null when unreported. */
    resetsAt: number | null;
    /** Epoch milliseconds when the window opened, or null when unreported. */
    startsAt: number | null;
    /** Window length in milliseconds, or null when unreported. */
    durationMs: number | null;
}

/**
 * Money that can still be spent after a rate-limit window is exhausted. Every
 * vendor sells this differently — Codex calls it credits, Grok splits prepaid
 * balance from an on-demand cap, Claude calls it extra usage — but they all
 * answer the same question: can this account keep working right now.
 */
export interface ProviderUsageCredits {
    /** Whether the account can spend credits at this moment. */
    available: boolean;
    /** Remaining balance in USD cents, or null when no amount is reported. */
    remainingCents: number | null;
    /** Whether the balance is unmetered. */
    unlimited: boolean;
    /** Share of a credit allowance consumed, from 0 to 100, or null. */
    usedPercent: number | null;
}

/** A single reading of one account's usage, normalized across vendors. */
export interface ProviderUsage {
    /** The Rig provider this reading belongs to. */
    providerId: string;
    vendor: ProviderUsageVendor;
    /** Epoch milliseconds when the reading was taken. */
    capturedAt: number;
    /** Human-readable plan name such as "Pro" or "Max", or null when unknown. */
    planName: string | null;
    /** Whether the vendor is refusing further requests on this account now. */
    exhausted: boolean;
    windows: {
        fiveHour: ProviderUsageWindow | null;
        weekly: ProviderUsageWindow | null;
        monthly: ProviderUsageWindow | null;
        /**
         * Claude's separate weekly Fable allowance. Optional so older readings
         * and vendors that never report it stay valid. Null when unreported.
         */
        fableWeekly?: ProviderUsageWindow | null;
    };
    /** Spendable balance, or null when the vendor reports none. */
    credits: ProviderUsageCredits | null;
}
