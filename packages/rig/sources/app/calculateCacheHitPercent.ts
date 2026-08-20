import type { Usage } from "../protocol/index.js";

export function calculateCacheHitPercent(usage: Usage): number {
    // Provider-normalized input already includes cache reads and writes. Cache reads are hits;
    // everything else in input is a miss, and output is not cache-eligible.
    const cacheReadTokens = Math.max(0, usage.cacheRead);
    const cacheEligibleTokens = Math.max(0, usage.input);
    if (cacheEligibleTokens <= 0) return 0;
    return Math.min(100, Math.round((cacheReadTokens / cacheEligibleTokens) * 100));
}
