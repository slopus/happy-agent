/**
 * Words for ranked search, split the way the SQLite FTS5 unicode61 tokenizer with
 * `remove_diacritics 2` splits them: runs of letters, digits, and combining marks, compared
 * without case or diacritics. Indexes built on that tokenizer and catalogs ranked in memory
 * therefore agree on what a word is.
 */
export function searchQueryWords(query: string): string[] {
    return query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** An FTS5 query requiring every word, each as a prefix of an indexed word. */
export function searchWordMatch(words: readonly string[]): string {
    return words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" ");
}

/**
 * Where in `text` a query word first starts a word, compared as the index does. The index is into
 * `text` itself, since folding keeps every character's length.
 */
export function firstSearchWordIndex(text: string, words: readonly string[]): number | undefined {
    const folded = foldQueryWords(words);
    if (folded.length === 0) return undefined;
    const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}\\p{M}])(?:${folded.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
        "u",
    );
    return pattern.exec(foldText(text))?.index;
}

/** The 1-based line holding `index`, and at most 200 characters of it around that point. */
export function searchLineAt(text: string, index: number): { line: number; snippet: string } {
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const lineEndAt = text.indexOf("\n", index);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    const line = text.slice(0, index).split("\n").length;
    const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (content.length <= 200) return { line, snippet: content };
    const start = Math.max(0, Math.min(index - lineStart - 80, content.length - 200));
    return { line, snippet: content.slice(start, start + 200) };
}

/** BM25's term-frequency saturation and document-length normalization, at their usual values. */
const K1 = 1.2;
const B = 0.75;

/**
 * Ranks short documents in memory as an FTS5 index would: a document matches when every query
 * word starts one of its words, and matches are ordered by Okapi BM25, best first, ties in input
 * order. Returns the indexes of the documents that matched.
 */
export function rankBySearchWords(
    documents: readonly string[],
    words: readonly string[],
): number[] {
    const query = [...new Set(foldQueryWords(words))];
    if (query.length === 0 || documents.length === 0) return [];
    const tokenized = documents.map(
        (document) => foldText(document).match(/[\p{L}\p{N}]+/gu) ?? [],
    );
    const averageLength =
        tokenized.reduce((total, tokens) => total + tokens.length, 0) / tokenized.length || 1;
    const frequencies = tokenized.map((tokens) =>
        query.map((word) => tokens.filter((token) => token.startsWith(word)).length),
    );
    const inverse = query.map((_, column) => {
        const containing = frequencies.filter((row) => row[column]! > 0).length;
        return Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
    });
    const matches: { index: number; score: number }[] = [];
    frequencies.forEach((row, index) => {
        if (row.some((frequency) => frequency === 0)) return;
        const length = tokenized[index]!.length;
        let score = 0;
        row.forEach((frequency, column) => {
            score +=
                (inverse[column]! * (frequency * (K1 + 1))) /
                (frequency + K1 * (1 - B + (B * length) / averageLength));
        });
        matches.push({ index, score });
    });
    return matches
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((match) => match.index);
}

/** Query words folded; a word's own combining marks fold to spaces, which are dropped. */
function foldQueryWords(words: readonly string[]): string[] {
    return words
        .map((word) => foldText(word).replaceAll(" ", ""))
        .filter((word) => word.length > 0);
}

/** Lower-cased, with diacritics dropped where that keeps the character's length. */
function foldText(text: string): string {
    let out = "";
    for (const char of text) {
        const bare = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        if (bare.length === char.length) out += bare;
        else if (bare.length === 0) out += " ".repeat(char.length);
        else out += char.toLowerCase().length === char.length ? char.toLowerCase() : char;
    }
    return out;
}
