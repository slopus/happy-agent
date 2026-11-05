/**
 * Query words for ranked search, split the way the word indexes' unicode61 tokenizer splits text:
 * runs of letters, digits, and combining marks.
 */
export function vaultQueryWords(query: string): string[] {
    return query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** An FTS5 query requiring every word, each as a prefix of an indexed word. */
export function vaultWordMatch(words: readonly string[]): string {
    return words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" ");
}

/**
 * Where in `text` a query word first starts a word, compared as the index does: ignoring case and
 * diacritics. The index is into `text` itself, since folding keeps every character's length.
 */
export function vaultWordIndex(text: string, words: readonly string[]): number | undefined {
    // A word's own combining marks fold to spaces, which a query word drops.
    const folded = words
        .map((word) => fold(word).replaceAll(" ", ""))
        .filter((word) => word.length > 0);
    if (folded.length === 0) return undefined;
    const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}\\p{M}])(?:${folded.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
        "u",
    );
    return pattern.exec(fold(text))?.index;
}

/** Lower-cased, with diacritics dropped where that keeps the character's length. */
function fold(text: string): string {
    let out = "";
    for (const char of text) {
        const bare = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        if (bare.length === char.length) out += bare;
        else if (bare.length === 0) out += " ".repeat(char.length);
        else out += char.toLowerCase().length === char.length ? char.toLowerCase() : char;
    }
    return out;
}
