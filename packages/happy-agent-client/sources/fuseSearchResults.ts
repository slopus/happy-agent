/** Reciprocal Rank Fusion's constant: a result at position `p` scores `1 / (60 + p)`. */
export const SEARCH_FUSION_K = 60;

/**
 * Fuse the daemon's search results with a client's own, ordered the same way on every
 * platform. Each remote result scores `1 / (60 + rank)` and each local one `1 / (60 + p)` at its
 * 1-based position `p`; results sharing a `key` are one result, scored as the sum, and carry the
 * remote fields when the daemon returned it. Highest score first; equal scores by remote rank,
 * results the daemon did not return last, then by local position.
 */
export function fuseSearchResults<
    Remote extends { readonly key: string; readonly rank: number },
    Local extends { readonly key: string },
>(remote: readonly Remote[], local: readonly Local[]): (Remote | Local)[] {
    const fused = new Map<
        string,
        { value: Remote | Local; score: number; remoteRank: number; localPosition: number }
    >();
    for (const result of remote) {
        if (fused.has(result.key)) continue;
        fused.set(result.key, {
            value: result,
            score: 1 / (SEARCH_FUSION_K + result.rank),
            remoteRank: result.rank,
            localPosition: Number.MAX_SAFE_INTEGER,
        });
    }
    local.forEach((result, index) => {
        const position = index + 1;
        const score = 1 / (SEARCH_FUSION_K + position);
        const found = fused.get(result.key);
        if (found === undefined)
            fused.set(result.key, {
                value: result,
                score,
                remoteRank: Number.MAX_SAFE_INTEGER,
                localPosition: position,
            });
        else if (found.localPosition === Number.MAX_SAFE_INTEGER) {
            found.score += score;
            found.localPosition = position;
        }
    });
    return [...fused.values()]
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.remoteRank - right.remoteRank ||
                left.localPosition - right.localPosition,
        )
        .map((entry) => entry.value);
}
