import { formatHistoryMessage, truncate } from "../../history/impl/formatHistoryMessage.js";
import { summarizeHistory, type HistoryStats } from "../../history/impl/summarizeHistory.js";
import type { HistoryRecord } from "../../history/HistoryStore.js";

/** How many of the earliest messages are worth showing: where the work was asked for. */
const BEGINNING_MESSAGES = 4;
/** How many of the latest ones: where it was left. */
const RECENT_MESSAGES = 8;
/** How much of one message is worth reading in an excerpt this short. */
const MESSAGE_TEXT_LIMIT = 1_500;

/** The two ends of a conversation, and what the whole of it amounted to. */
export interface HistoryExcerpt {
    /** The earliest messages, rendered. */
    readonly beginning: string;
    /** The latest messages, rendered, empty when the beginning already covers them. */
    readonly recent: string;
    /** What the whole history amounts to. */
    readonly stats: HistoryStats;
    /**
     * True when the reader supplied only the bounded two-ended sample and no exact aggregate.
     * Callers must label these counts as sampled rather than archive-wide totals.
     */
    readonly statsAreSampled: boolean;
}

/**
 * The two ends of a conversation a new model cannot see.
 *
 * Both ends matter and the middle rarely does: the beginning is where the user said what they
 * wanted, and the end is where the work was left. A long conversation between them cannot be
 * shown at all, and pretending otherwise would just push the useful parts out of the budget, so
 * the excerpt keeps the ends and says how much it is not showing.
 */
export function createHistoryExcerpt(
    records: readonly HistoryRecord[],
    budget: number,
    exactStats?: HistoryStats,
): HistoryExcerpt {
    const beginningRecords = records.slice(0, BEGINNING_MESSAGES);
    const recentStart = Math.max(BEGINNING_MESSAGES, records.length - RECENT_MESSAGES);
    const recentRecords = records.slice(recentStart);
    const beginningBudget = recentRecords.length === 0 ? budget : Math.floor(budget / 3);
    const beginning = render(beginningRecords, beginningBudget, false);
    const recent = render(recentRecords, Math.max(0, budget - beginning.length), true);
    return {
        beginning,
        recent,
        stats: exactStats ?? summarizeHistory(records.map((record) => record.message)),
        statsAreSampled: exactStats === undefined,
    };
}

/** Render as many of these messages as fit, filling from whichever end matters. */
function render(records: readonly HistoryRecord[], budget: number, fromEnd: boolean): string {
    const formatted = records.map((record) =>
        formatHistoryMessage(record.message, record.position + 1, {
            textLimit: MESSAGE_TEXT_LIMIT,
        }),
    );
    const selected: string[] = [];
    let characters = 0;
    const indexes = fromEnd
        ? Array.from({ length: formatted.length }, (_, index) => formatted.length - index - 1)
        : formatted.map((_, index) => index);
    for (const index of indexes) {
        const message = formatted[index] ?? "";
        const separator = selected.length === 0 ? 0 : 2;
        const remaining = budget - characters - separator;
        if (remaining <= 0 || (selected.length > 0 && message.length > remaining)) break;
        const bounded = truncate(message, remaining);
        if (fromEnd) selected.unshift(bounded);
        else selected.push(bounded);
        characters += separator + bounded.length;
    }
    return selected.join("\n\n");
}
