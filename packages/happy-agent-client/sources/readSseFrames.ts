/** One frame read off a Server-Sent Events stream. */
export interface SseFrame {
    /** The `event:` field, when the frame carried one. */
    name: string | undefined;
    /** The `id:` field, which on this API is the event's cursor. */
    id: string | undefined;
    /** The joined `data:` lines, still unparsed. */
    data: string;
}

/**
 * Reads Server-Sent Events out of a byte stream.
 *
 * Framing lives here rather than at the call site because the details are easy
 * to get subtly wrong: a line may end with a carriage return, a newline, or
 * both; a chunk may split a line ending in half; and comment frames — the
 * heartbeats that keep the connection alive through proxies — carry no data and
 * are dropped.
 */
export async function* readSseFrames(
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<SseFrame> {
    // The bytes are decoded here rather than piped through a TextDecoderStream
    // so that a caller only ever has to hand over the response body it already
    // holds, with no stream plumbing of its own.
    const decoder = new TextDecoder();
    const reader = body.getReader();
    // The normalized text after the last frame boundary, kept as the pieces it
    // arrived in. A single event can run to tens of megabytes, so each chunk is
    // normalized and searched on its own and the pieces are joined once, when
    // the frame completes, rather than rescanning everything on every chunk.
    let pending: string[] = [];
    // A chunk that ends in a carriage return keeps it unresolved: the next
    // chunk may begin with the newline that completes it, and deciding early
    // would turn one line ending into two.
    let heldCarriageReturn = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                // A stream that ends without a trailing blank line still
                // delivered a whole final frame.
                const last = parseFrame(pending.join("") + (heldCarriageReturn ? "\n" : ""));
                if (last !== undefined) yield last;
                return;
            }
            let text = decoder.decode(value, { stream: true });
            if (heldCarriageReturn) text = `\r${text}`;
            heldCarriageReturn = text.endsWith("\r");
            text = normalizeLineEndings(heldCarriageReturn ? text.slice(0, -1) : text);
            if (text.length === 0) continue;
            let start = 0;
            if (text.startsWith("\n") && pending.at(-1)?.endsWith("\n") === true) {
                // The blank line ending this frame straddles the chunk boundary.
                const frame = parseFrame(pending.join("").slice(0, -1));
                pending = [];
                start = 1;
                if (frame !== undefined) yield frame;
            }
            for (;;) {
                const boundary = text.indexOf("\n\n", start);
                if (boundary < 0) break;
                const tail = text.slice(start, boundary);
                const frame = parseFrame(pending.length === 0 ? tail : pending.join("") + tail);
                pending = [];
                start = boundary + 2;
                if (frame !== undefined) yield frame;
            }
            if (start < text.length) pending.push(text.slice(start));
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/gu, "\n");
}

function parseFrame(raw: string): SseFrame | undefined {
    if (raw.length === 0 || raw.startsWith(":")) return undefined;
    const lines = raw.split("\n");
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).replace(/^ /u, ""));
    if (data.length === 0) return undefined;
    return {
        data: data.join("\n"),
        id: readField(lines, "id"),
        name: readField(lines, "event"),
    };
}

function readField(lines: string[], field: string): string | undefined {
    const line = lines.find((candidate) => candidate.startsWith(`${field}:`));
    return line?.slice(field.length + 1).replace(/^ /u, "");
}
