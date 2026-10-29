const segmenter = new Intl.Segmenter("en", { granularity: "word" });

/** BM25's term-frequency saturation and document-length normalization, at their usual values. */
const K1 = 1.2;
const B = 0.75;
/** Query words this short match only whole words; longer ones also match words they begin. */
const MIN_PREFIX_LENGTH = 3;

/** One document that matched, by its index in the input, with its BM25 score. */
export interface Bm25Match {
    readonly index: number;
    readonly score: number;
}

/**
 * Ranks short documents against a query with Okapi BM25, best first, ties in input order.
 *
 * Text is folded to lowercase without accents, and `_`, `-`, `.`, and `/` separate words, so
 * snake_case usernames, kebab-case branches, and folder paths match the words they are made of.
 * A query word of three or more characters also matches document words it begins, so "clean"
 * finds "cleanup"; every word it matches counts toward its frequency. Documents matching no query
 * word are left out. An empty query matches nothing.
 */
export function rankBm25(documents: readonly string[], query: string): readonly Bm25Match[] {
    const queryWords = [...new Set(bm25Words(query))];
    if (queryWords.length === 0 || documents.length === 0) return [];
    const tokenized = documents.map(bm25Words);
    const averageLength =
        tokenized.reduce((total, words) => total + words.length, 0) / tokenized.length || 1;
    const matchesWord = (queryWord: string, word: string): boolean =>
        word === queryWord || (queryWord.length >= MIN_PREFIX_LENGTH && word.startsWith(queryWord));
    const frequencies = tokenized.map((words) =>
        queryWords.map((queryWord) => words.filter((word) => matchesWord(queryWord, word)).length),
    );
    const inverseDocumentFrequency = queryWords.map((_, column) => {
        const containing = frequencies.filter((row) => row[column]! > 0).length;
        return Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
    });
    const matches: Bm25Match[] = [];
    frequencies.forEach((row, index) => {
        const length = tokenized[index]!.length;
        let score = 0;
        row.forEach((frequency, column) => {
            if (frequency === 0) return;
            score +=
                (inverseDocumentFrequency[column]! * (frequency * (K1 + 1))) /
                (frequency + K1 * (1 - B + (B * length) / averageLength));
        });
        if (score > 0) matches.push({ index, score });
    });
    return matches.sort((left, right) => right.score - left.score || left.index - right.index);
}

/** The folded words BM25 compares. */
export function bm25Words(text: string): string[] {
    const folded = text
        .normalize("NFKD")
        .replace(/\p{Mark}/gu, "")
        .toLowerCase()
        .replace(/[_\-./\\]+/g, " ");
    return Array.from(segmenter.segment(folded))
        .filter((segment) => segment.isWordLike)
        .map((segment) => segment.segment);
}
