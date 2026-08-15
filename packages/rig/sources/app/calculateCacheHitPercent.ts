import type { Usage } from "../protocol/index.js";

export function calculateCacheHitPercent(usage: Usage): number {
    // Cache writes and uncached input are misses; output tokens are not cache-eligible input.
    const cacheReadTokens = Math.max(0, usage.cacheRead);
    const cacheEligibleTokens =
        Math.max(0, usage.input) + cacheReadTokens + Math.max(0, usage.cacheWrite);
    if (cacheEligibleTokens <= 0) return 0;
    return Math.min(100, Math.round((cacheReadTokens / cacheEligibleTokens) * 100));
}
