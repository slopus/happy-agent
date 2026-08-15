import type { Usage } from "../protocol/index.js";

import { calculateCacheHitPercent } from "./calculateCacheHitPercent.js";
import { formatCompactTokens } from "./formatCompactTokens.js";

export function formatSessionTokenStatus(options: {
    contextTokens: number;
    contextWindow?: number;
    sessionTokens: number;
    usage: Usage;
}): string {
    const parts = [
        `${formatCompactTokens(options.sessionTokens)} tokens`,
        `${calculateCacheHitPercent(options.usage)}% cache hit`,
    ];
    if (options.contextWindow !== undefined && options.contextWindow > 0) {
        const contextLeftPercent = Math.min(
            100,
            Math.max(0, Math.round((1 - options.contextTokens / options.contextWindow) * 100)),
        );
        parts.push(`${contextLeftPercent}% ctx left`);
    }
    return parts.join(" · ");
}
