/** How long Happy seems to think before the first words, in milliseconds. */
export const FIRST_TOKEN_MS = { min: 300, max: 500 } as const;
/** The gap between chunks, in milliseconds. */
const CHUNK_GAP_MS = { min: 30, max: 60 } as const;

export interface StreamChunk {
    /** The text this chunk appends. */
    readonly text: string;
    /** How long to wait after sending it. */
    readonly afterMs: number;
}

/**
 * `text` cut the way a model's output streams: chunks of a word or a few, now and then a short
 * phrase, each followed by a 30–60 ms gap with jitter. That is about 50–80 tokens a second, so a
 * two-sentence message lands in about a second. Every chunk ends after whitespace or punctuation
 * when it can, so words are never split; the chunks join back into exactly `text`.
 */
export function streamLikeInference(
    text: string,
    random: () => number = Math.random,
): StreamChunk[] {
    // Words with the whitespace that follows them.
    const pieces = text.match(/\S+\s*|\s+/gu) ?? [];
    const chunks: StreamChunk[] = [];
    for (let index = 0; index < pieces.length; ) {
        const roll = random();
        // Mostly one or two words, sometimes three or four, now and then a short phrase.
        const words =
            roll < 0.45 ? 1 : roll < 0.8 ? 2 : roll < 0.95 ? 3 + Math.floor(random() * 2) : 5;
        const end = Math.min(pieces.length, index + words);
        chunks.push({
            text: pieces.slice(index, end).join(""),
            afterMs: Math.round(
                CHUNK_GAP_MS.min + random() * (CHUNK_GAP_MS.max - CHUNK_GAP_MS.min),
            ),
        });
        index = end;
    }
    return chunks;
}

/** The pause before the first chunk. */
export function firstTokenDelay(random: () => number = Math.random): number {
    return Math.round(FIRST_TOKEN_MS.min + random() * (FIRST_TOKEN_MS.max - FIRST_TOKEN_MS.min));
}
