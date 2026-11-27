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
    const framer = new SseFramer();
    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                // A stream that ends without a trailing blank line still
                // delivered a whole final frame.
                const last = framer.end();
                if (last !== undefined) yield last;
                return;
            }
            framer.push(value);
            for (;;) {
                const frame = framer.take();
                if (frame === undefined) break;
                yield frame;
            }
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}

/**
 * Cuts decoded text into frames, examining each character a bounded number of
 * times.
 *
 * A single event can run to tens of megabytes, so each chunk is normalized and
 * searched on its own, and the text after the last frame boundary is kept as
 * the pieces it arrived in, joined once when the frame completes. The strings
 * live here rather than in the generator, whose suspended state would keep a
 * consumed chunk reachable until the next one arrives.
 */
class SseFramer {
    // The bytes are decoded here rather than piped through a TextDecoderStream
    // so that a caller only ever has to hand over the response body it already
    // holds, with no stream plumbing of its own.
    private readonly decoder = new TextDecoder();
    private pending: string[] = [];
    // A chunk that ends in a carriage return keeps it unresolved: the next
    // chunk may begin with the newline that completes it, and deciding early
    // would turn one line ending into two.
    private heldCarriageReturn = false;
    /** The newest chunk's normalized text, and how far into it frames were taken. */
    private text = "";
    private start = 0;

    /** Accepts a chunk; its frames are then read with `take` until it returns nothing. */
    push(bytes: Uint8Array<ArrayBuffer>): void {
        let text = this.decoder.decode(bytes, { stream: true });
        if (this.heldCarriageReturn) text = `\r${text}`;
        this.heldCarriageReturn = text.endsWith("\r");
        this.text = normalizeLineEndings(this.heldCarriageReturn ? text.slice(0, -1) : text);
        this.start = 0;
    }

    take(): SseFrame | undefined {
        for (;;) {
            const raw = this.nextRaw();
            if (raw === undefined) return undefined;
            const frame = parseFrame(raw);
            if (frame !== undefined) return frame;
        }
    }

    /** The text of the next frame the newest chunk completes, if it completes one. */
    private nextRaw(): string | undefined {
        if (
            this.start === 0 &&
            this.text.startsWith("\n") &&
            this.pending.at(-1)?.endsWith("\n") === true
        ) {
            // The blank line ending this frame straddles the chunk boundary.
            const raw = this.pending.join("").slice(0, -1);
            this.pending = [];
            this.start = 1;
            return raw;
        }
        const boundary = this.text.indexOf("\n\n", this.start);
        if (boundary < 0) {
            this.keepRest();
            return undefined;
        }
        const tail = this.text.slice(this.start, boundary);
        const raw = this.pending.length === 0 ? tail : this.pending.join("") + tail;
        this.pending = [];
        this.start = boundary + 2;
        return raw;
    }

    end(): SseFrame | undefined {
        const raw = this.pending.join("") + (this.heldCarriageReturn ? "\n" : "");
        this.pending = [];
        return parseFrame(raw);
    }

    private keepRest(): void {
        const { text, start } = this;
        this.text = "";
        this.start = 0;
        if (start === 0) {
            if (text.length > 0) this.pending.push(text);
        } else if (start < text.length) {
            // A slice would keep the whole chunk alive for the sake of its end.
            this.pending.push(detach(text.slice(start)));
        }
    }
}

const detachEncoder = new TextEncoder();
const detachDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Copies a string so it no longer shares storage with the one it was sliced
 * from.
 *
 * Engines keep a slice pointing into its parent, and JavaScriptCore does the
 * same for a slice of a concatenation; a round trip through bytes is a real
 * copy everywhere. The text came from a decoder, so it survives intact.
 */
function detach(text: string): string {
    return detachDecoder.decode(detachEncoder.encode(text));
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
