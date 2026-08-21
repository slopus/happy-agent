import type { Usage } from "../protocol/index.js";

import { formatWorkUsageSummary } from "./formatWorkUsageSummary.js";

export function formatSessionTokenStatus(options: {
    contextTokens: number;
    contextWindow?: number;
    usage: Usage;
}): string {
    const parts = [formatWorkUsageSummary(options.usage, { contextTokens: options.contextTokens })];
    if (options.contextWindow !== undefined && options.contextWindow > 0) {
        const contextLeftPercent = Math.min(
            100,
            Math.max(0, Math.round((1 - options.contextTokens / options.contextWindow) * 100)),
        );
        parts.push(`${contextLeftPercent}% ctx left`);
    }
    return parts.join(" · ");
}
