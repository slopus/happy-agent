import { Value } from "@sinclair/typebox/value";

import type { HistoryQuery, HistoryPage } from "../HistoryPage.js";
import { historyQuerySchema, historyRecordSchema, type HistoryRecord } from "../HistoryPage.js";
import { MAX_HISTORY_POSITION, MAX_HISTORY_TOTAL_MESSAGES } from "../HistoryMessage.js";
import { messageMatchesHistoryFilters } from "./messageMatchesHistoryFilters.js";
import { summarizeHistory } from "./summarizeHistory.js";

/** The part of a page that depends only on the records and the query. */
export type SelectedHistoryPage = Omit<HistoryPage, "agentId">;

/**
 * Cut one page out of an agent's history.
 *
 * Filtering happens first and paging second, so a cursor always names a real position in the
 * whole history rather than an offset into a particular search. That is what lets a reader
 * change its mind — narrow the query, ask for the page before — without the positions it
 * already has meaning something else.
 */
export function selectHistoryPage(
    records: readonly HistoryRecord[],
    options: HistoryQuery,
): SelectedHistoryPage {
    if (
        !Value.Check(historyQuerySchema, options) ||
        records.length > MAX_HISTORY_TOTAL_MESSAGES ||
        records.some((record) => !Value.Check(historyRecordSchema, record))
    ) {
        throw new Error("History selection received malformed state.");
    }
    const recordIds = new Set<string>();
    let previousPosition = -1;
    for (const record of records) {
        if (record.position <= previousPosition || recordIds.has(record.message.recordId)) {
            throw new Error("History selection received unstable records.");
        }
        previousPosition = record.position;
        recordIds.add(record.message.recordId);
    }
    if (options.cursor !== undefined && options.from !== undefined) {
        throw new Error("Use either cursor or from, not both.");
    }
    const limit = Math.max(1, options.limit ?? 100);
    const matched = records.filter((record) =>
        messageMatchesHistoryFilters(record.message, options),
    );
    const first = records[0]?.position ?? 0;
    const lastPosition = records.at(-1)?.position;
    const end =
        lastPosition === undefined
            ? first
            : lastPosition >= MAX_HISTORY_POSITION
              ? MAX_HISTORY_POSITION
              : lastPosition + 1;
    const anchor = options.cursor === undefined ? first : Math.max(options.cursor, first);
    const start =
        options.from === "end"
            ? Math.max(0, matched.length - limit)
            : matched.findIndex((record) => record.position >= anchor);
    const startIndex = start < 0 ? matched.length : start;
    const selected = matched.slice(startIndex, startIndex + limit);
    const cursor = selected[0]?.position ?? (options.from === "end" ? end : anchor);
    const next = matched[startIndex + selected.length];
    const beyondEnd = options.cursor !== undefined && startIndex === matched.length;
    const previous = matched[Math.max(0, startIndex - limit)];
    return {
        cursor,
        matchedMessages: matched.length,
        matchedStats: summarizeHistory(matched.map((record) => record.message)),
        messages: selected,
        ...(next === undefined ? {} : { nextCursor: next.position }),
        ...(previous === undefined || (startIndex === 0 && !beyondEnd)
            ? {}
            : { previousCursor: previous.position }),
        totalMessages: records.length,
        totalStats: summarizeHistory(records.map((record) => record.message)),
    };
}
