import { rankBm25 } from "../../utils/rankBm25.js";
import {
    DEFAULT_CLEANUP_PAGE_SIZE,
    type CleanupItem,
    type CleanupSearchPage,
    type CleanupSearchQuery,
    type CleanupSearchResult,
} from "../CleanupSearch.js";
import type { CleanupEntry } from "./collectCleanupEntries.js";

/**
 * Filters, ranks, orders, and pages the rows of one read of the installation.
 *
 * With a query, only rows BM25 matches are kept and the default order is relevance; without one
 * every row is kept and the default order is most recently active first. `stale` puts the longest
 * inactive first. A row with a run open now counts as active at `now`. Ties keep a stable order
 * by kind and ID so a cursor walks the same sequence page after page.
 */
export function searchCleanupEntries(
    entries: readonly CleanupEntry[],
    query: CleanupSearchQuery,
    now: number,
): CleanupSearchPage {
    const activeAt = (item: CleanupItem): number => (item.running ? now : item.lastActivityAt);
    const filtered = entries.filter(({ item }) => {
        if (query.kinds !== undefined && !query.kinds.includes(item.kind)) return false;
        if (query.status !== undefined && item.status !== query.status) return false;
        if (query.ownerUserId !== undefined && item.ownerUserId !== query.ownerUserId) return false;
        if (query.activeSince !== undefined && activeAt(item) < query.activeSince) return false;
        if (query.inactiveSince !== undefined && activeAt(item) >= query.inactiveSince) {
            return false;
        }
        if (query.createdAfter !== undefined && item.createdAt < query.createdAfter) return false;
        if (query.createdBefore !== undefined && item.createdAt >= query.createdBefore) {
            return false;
        }
        return true;
    });
    const text = query.query?.trim() ?? "";
    let results: CleanupSearchResult[];
    if (text.length === 0) {
        results = filtered.map(({ item }) => ({ item }));
    } else {
        results = rankBm25(
            filtered.map((entry) => entry.text),
            text,
        ).map(({ index, score }) => ({ item: filtered[index]!.item, score }));
    }
    const sort = query.sort ?? (text.length === 0 ? "recent" : "relevance");
    const identity = (left: CleanupItem, right: CleanupItem): number =>
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    results.sort((left, right) => {
        if (sort === "relevance") {
            return (
                (right.score ?? 0) - (left.score ?? 0) ||
                activeAt(right.item) - activeAt(left.item) ||
                identity(left.item, right.item)
            );
        }
        const byActivity = activeAt(right.item) - activeAt(left.item);
        return (sort === "recent" ? byActivity : -byActivity) || identity(left.item, right.item);
    });
    const cursor = query.cursor ?? 0;
    const page = results.slice(cursor, cursor + (query.limit ?? DEFAULT_CLEANUP_PAGE_SIZE));
    const next = cursor + page.length;
    return {
        results: page,
        sort,
        total: results.length,
        cursor,
        ...(next < results.length ? { nextCursor: next } : {}),
        at: now,
    };
}
