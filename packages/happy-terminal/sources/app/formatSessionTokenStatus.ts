import type { Usage } from "../protocol/index.js";

import { formatUsageTokens, formatWorkUsageSummary } from "./formatWorkUsageSummary.js";

/** At or below this much remaining context the indicator becomes a warning. */
export const CONTEXT_LOW_PERCENT = 20;

export interface ContextRemaining {
    /** Whole percent of the usable context still free, clamped to the 0 to 100 range. */
    readonly percentLeft: number;
    /** True when the limit is the automatic-compaction threshold rather than the hard window. */
    readonly untilCompaction: boolean;
}

/**
 * How much context remains before the conversation is compacted.
 *
 * The daemon compacts once the measured context reaches the model's `autoCompactWindow`, so that
 * is the limit the countdown measures against: it reaches zero at the moment compaction happens.
 * The hard `contextWindow` stands in only for a daemon that does not publish a threshold.
 */
export function contextRemaining(options: {
    autoCompactWindow?: number;
    contextTokens: number;
    contextWindow?: number;
}): ContextRemaining | undefined {
    const limit = options.autoCompactWindow ?? options.contextWindow;
    if (limit === undefined || limit <= 0) return undefined;
    const percentLeft = Math.min(
        100,
        Math.max(0, Math.round((1 - options.contextTokens / limit) * 100)),
    );
    return { percentLeft, untilCompaction: options.autoCompactWindow !== undefined };
}

export function formatContextRemaining(remaining: ContextRemaining): string {
    return remaining.untilCompaction
        ? `${remaining.percentLeft}% until auto-compact`
        : `${remaining.percentLeft}% ctx left`;
}

export function formatSessionTokenStatus(options: {
    autoCompactWindow?: number;
    contextTokens: number;
    contextWindow?: number;
    usage: Usage;
    /** Styles the context figure once it is at or below `CONTEXT_LOW_PERCENT`. */
    warn?: (text: string) => string;
}): string {
    const parts = [formatWorkUsageSummary(options.usage, { contextTokens: options.contextTokens })];
    const remaining = contextRemaining(options);
    if (remaining !== undefined) {
        const text = formatContextRemaining(remaining);
        parts.push(
            remaining.percentLeft <= CONTEXT_LOW_PERCENT && options.warn !== undefined
                ? options.warn(text)
                : text,
        );
    }
    return parts.join(" · ");
}

/**
 * The one-line context report for the token usage event: occupancy against the limit the
 * countdown measures, with the hard window named separately when the two differ.
 */
export function formatContextLine(
    contextTokens: number,
    model: { autoCompactWindow?: number; contextWindow?: number },
): string {
    const used = formatUsageTokens(contextTokens);
    const remaining = contextRemaining({ ...model, contextTokens });
    if (remaining === undefined) return `Context: ${used}`;
    const limit = model.autoCompactWindow ?? model.contextWindow ?? 0;
    const window =
        remaining.untilCompaction && model.contextWindow !== undefined
            ? ` (window ${formatUsageTokens(model.contextWindow)})`
            : "";
    return `Context: ${used} / ${formatUsageTokens(limit)} · ${formatContextRemaining(remaining)}${window}`;
}
