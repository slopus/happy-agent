/** Starting points tried per path, so a long path full of the query's first letter stays cheap. */
const MAX_MATCH_STARTS = 16;

/**
 * Ranks relative file paths against a typed query the way a person scans for a file: the letters
 * in order, preferring runs of them, word and folder starts, and the file's own name. An empty
 * query lists the shallowest files first.
 */
export function rankFilePaths(
    paths: readonly string[],
    query: string,
    limit: number,
): { readonly fileName: string; readonly path: string }[] {
    const needle = query.replaceAll(/\s+/gu, "").toLowerCase();
    const ranked: { path: string; score: number }[] = [];
    for (const path of paths) {
        const score =
            needle.length === 0 ? -depth(path) - path.length / 1000 : scorePath(path, needle);
        if (score !== undefined) ranked.push({ path, score });
    }
    ranked.sort((left, right) => right.score - left.score || compare(left.path, right.path));
    return ranked.slice(0, limit).map(({ path }) => ({ fileName: fileName(path), path }));
}

function scorePath(path: string, needle: string): number | undefined {
    const lower = path.toLowerCase();
    const nameStart = path.lastIndexOf("/") + 1;
    let best: number | undefined;
    let start = lower.indexOf(needle[0] as string);
    for (let tried = 0; start >= 0 && tried < MAX_MATCH_STARTS; tried += 1) {
        const score = scoreFrom(path, lower, needle, start, nameStart);
        if (score !== undefined && (best === undefined || score > best)) best = score;
        start = lower.indexOf(needle[0] as string, start + 1);
    }
    return best === undefined ? undefined : best - path.length / 100;
}

function scoreFrom(
    path: string,
    lower: string,
    needle: string,
    start: number,
    nameStart: number,
): number | undefined {
    let score = 0;
    let previous = -2;
    let position = start;
    for (const character of needle) {
        const found = lower.indexOf(character, position);
        if (found < 0) return undefined;
        score += 1;
        if (found === previous + 1) score += 5;
        if (isWordStart(path, found)) score += 8;
        if (found >= nameStart) score += 2;
        previous = found;
        position = found + 1;
    }
    return score;
}

function isWordStart(path: string, index: number): boolean {
    if (index === 0) return true;
    const before = path[index - 1] as string;
    if ("/._- ".includes(before)) return true;
    const current = path[index] as string;
    return current !== current.toLowerCase() && before === before.toLowerCase();
}

function depth(path: string): number {
    let count = 0;
    for (const character of path) if (character === "/") count += 1;
    return count;
}

function fileName(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
