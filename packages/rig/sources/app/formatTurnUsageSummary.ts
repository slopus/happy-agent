import type { Usage } from "../protocol/index.js";

import { calculateCacheHitPercent } from "./calculateCacheHitPercent.js";
import { formatCompactTokens } from "./formatCompactTokens.js";

export function formatTurnUsageSummary(usage: Usage): string {
    const generatedTokens = Math.max(0, usage.output);
    return `${formatCompactTokens(generatedTokens)} generated · ${calculateCacheHitPercent(usage)}% cache hit`;
}
