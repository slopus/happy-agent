import type { Usage } from "../protocol/index.js";

import { calculateCacheHitPercent } from "./calculateCacheHitPercent.js";

type WorkUsage = Pick<Usage, "cacheRead" | "input" | "output">;
type DetailedUsage = WorkUsage & Pick<Usage, "cacheWrite">;

/** Human-scale work volume for compact status rows. */
export function formatWorkUsageSummary(
    usage: WorkUsage,
    options: { readonly contextTokens?: number; readonly usedTokens?: number } = {},
): string {
    const parts = [
        `${formatUsageTokens(options.usedTokens ?? calculateUsedTokens(usage))} used`,
        `${calculateCacheHitPercent(usage)}% cache hit`,
    ];
    if (options.contextTokens !== undefined) {
        parts.push(`${formatUsageTokens(options.contextTokens)} context`);
    }
    return parts.join(" · ");
}

/** Full provider counters for multiline usage views. */
export function formatWorkUsageDetails(usage: DetailedUsage): string[] {
    return [
        `Used: ${formatUsageTokens(calculateUsedTokens(usage))}`,
        `Input: ${formatUsageTokens(usage.input)}`,
        `Output: ${formatUsageTokens(usage.output)}`,
        `Cache read: ${formatUsageTokens(usage.cacheRead)}`,
        `Cache write: ${formatUsageTokens(usage.cacheWrite)}`,
        `Cache hit: ${calculateCacheHitPercent(usage)}%`,
    ];
}

/** Keep one decimal at token-display scales so usage remains informative. */
export function formatUsageTokens(value: number): string {
    const tokens = Math.max(0, Math.round(value));
    if (tokens < 1_000) return String(tokens);
    if (tokens < 1_000_000) return `${formatScaled(tokens / 1_000)}k`;
    return `${formatScaled(tokens / 1_000_000)}m`;
}

function formatScaled(value: number): string {
    return value.toFixed(1).replace(/\.0$/u, "");
}

export function calculateUsedTokens(usage: WorkUsage): number {
    return Math.max(0, usage.input - usage.cacheRead) + Math.max(0, usage.output);
}
