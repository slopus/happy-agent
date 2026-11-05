import type { SearchResult } from "@slopus/happy-agent-client";

import type { SearchHit } from "../../utils/searchHit.js";

/** Reciprocal Rank Fusion's constant: a hit at position `p` of its list scores `1 / (60 + p)`. */
const K = 60;

/**
 * Fuse the providers' lists, given in provider order, with Reciprocal Rank Fusion. Hits sharing a
 * key are one result scored as the sum; equal scores follow provider order, then position. The
 * first `limit` results are ranked from 1, and `truncated` says more matched.
 */
export function fuseSearchHits(
    lists: readonly (readonly SearchHit[])[],
    limit: number,
): { results: SearchResult[]; truncated: boolean } {
    const fused = new Map<
        string,
        { hit: SearchHit; score: number; provider: number; position: number }
    >();
    lists.forEach((hits, provider) => {
        hits.forEach((hit, index) => {
            const score = 1 / (K + index + 1);
            const existing = fused.get(hit.key);
            if (existing === undefined)
                fused.set(hit.key, { hit, score, provider, position: index + 1 });
            else existing.score += score;
        });
    });
    const ordered = [...fused.values()].sort(
        (left, right) =>
            right.score - left.score ||
            left.provider - right.provider ||
            left.position - right.position,
    );
    return {
        results: ordered
            .slice(0, limit)
            .map(({ hit }, index) => ({ ...hit, rank: index + 1 }) as SearchResult),
        truncated: ordered.length > limit,
    };
}
