import { describe, expect, it } from "vitest";

import { readSseFrames, type SseFrame } from "../sources/readSseFrames.js";

/** Delivers the text in the given pieces, so chunk boundaries can be placed anywhere. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
    const encoder = new TextEncoder();
    return bytesStreamOf(chunks.map((chunk) => encoder.encode(chunk)));
}

function bytesStreamOf(chunks: Uint8Array<ArrayBuffer>[]): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

async function collect(
    stream: ReadableStream<Uint8Array<ArrayBuffer>>,
    read: typeof readSseFrames = readSseFrames,
) {
    const frames: SseFrame[] = [];
    for await (const frame of read(stream)) frames.push(frame);
    return frames;
}

/**
 * The framing as it was before it was made linear, kept verbatim so the
 * rewrite can be checked against it on arbitrary chunkings.
 */
async function* readSseFramesReference(
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<SseFrame> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                const last = parseFrame(normalizeLineEndings(buffer));
                if (last !== undefined) yield last;
                return;
            }
            buffer = holdBackSplitLineEnding(buffer + decoder.decode(value, { stream: true }));
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                const frame = parseFrame(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
                if (frame !== undefined) yield frame;
            }
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }

    function holdBackSplitLineEnding(text: string): string {
        if (!text.endsWith("\r")) return normalizeLineEndings(text);
        return `${normalizeLineEndings(text.slice(0, -1))}\r`;
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
}

/** A small deterministic generator, so a failing case can be replayed from its seed. */
function randomFrom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

/** Text built from the pieces SSE framing cares about, multi-byte characters included. */
function randomSseText(random: () => number): string {
    const pieces = [
        "data:",
        "data: ",
        "id:",
        "id: c",
        "event:",
        "event: e",
        ":",
        " ",
        "x",
        "é",
        "€",
        "😀",
        "\r",
        "\n",
        "\r\n",
        "\n\n",
        "\r\n\r\n",
        "\r\r",
    ];
    let text = "";
    const length = Math.floor(random() * 60);
    for (let index = 0; index < length; index += 1) {
        text += pieces[Math.floor(random() * pieces.length)];
    }
    return text;
}

/** Cuts the bytes at random points; chunks may be one byte, or empty. */
function randomChunks(
    bytes: Uint8Array<ArrayBuffer>,
    random: () => number,
): Uint8Array<ArrayBuffer>[] {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const maxChunk = 1 + Math.floor(random() * 8);
    let start = 0;
    while (start < bytes.length) {
        const end = Math.min(bytes.length, start + Math.floor(random() * (maxChunk + 1)));
        chunks.push(bytes.slice(start, end));
        start = end;
    }
    return chunks;
}

function eachByte(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
    return Array.from(bytes, (_, index) => bytes.slice(index, index + 1));
}

describe("readSseFrames", () => {
    it("reads a frame's event, id, and data", async () => {
        const frames = await collect(streamOf("id: c1\nevent: run.started\ndata: {}\n\n"));

        expect(frames).toEqual([{ id: "c1", name: "run.started", data: "{}" }]);
    });

    it("joins the data lines of one frame", async () => {
        const frames = await collect(streamOf('data: {"a":1,\ndata: "b":2}\n\n'));

        expect(frames[0]?.data).toBe('{"a":1,\n"b":2}');
    });

    it("reads frames split across chunk boundaries, carriage returns included", async () => {
        const frames = await collect(
            streamOf("event: one\r\ndata: 1\r", "\n\r\nevent: two\r\ndata: 2\r\n\r\n"),
        );

        expect(frames.map((frame) => frame.name)).toEqual(["one", "two"]);
        expect(frames.map((frame) => frame.data)).toEqual(["1", "2"]);
    });

    it("drops the comment heartbeats that keep the connection alive", async () => {
        const frames = await collect(streamOf(": heartbeat\n\ndata: 1\n\n"));

        expect(frames).toHaveLength(1);
    });

    it("delivers a final frame that arrived without its trailing blank line", async () => {
        const frames = await collect(streamOf("event: last\ndata: 1"));

        expect(frames).toEqual([{ id: undefined, name: "last", data: "1" }]);
    });

    it("cancels the body when the reader stops early", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("data: 1\n\ndata: 2\n\n"));
            },
            cancel() {
                cancelled = true;
            },
        });

        for await (const _frame of readSseFrames(body)) break;

        expect(cancelled).toBe(true);
    });

    it("reads many small frames delivered in one chunk", async () => {
        const text = Array.from(
            { length: 20_000 },
            (_, index) => `id: ${index}\ndata: ${index}\n\n`,
        ).join("");

        const frames = await collect(streamOf(text));

        expect(frames).toHaveLength(20_000);
        expect(frames[19_999]).toEqual({ id: "19999", name: undefined, data: "19999" });
    });

    it("reads one large frame delivered in small chunks", async () => {
        const payload = "é".repeat(1_000_000);
        const bytes = new TextEncoder().encode(
            `event: big\r\ndata: ${payload}\r\n\r\ndata: after\r\n\r\n`,
        );
        const chunks = [];
        // An odd chunk size splits the two-byte characters and the line endings.
        for (let start = 0; start < bytes.length; start += 1023)
            chunks.push(bytes.slice(start, start + 1023));

        const frames = await collect(bytesStreamOf(chunks));

        expect(frames).toEqual([
            { id: undefined, name: "big", data: payload },
            { id: undefined, name: undefined, data: "after" },
        ]);
    });

    it("frames every split of a stream as the reference framing does", async () => {
        const encoder = new TextEncoder();
        const texts = [
            "event: one\r\ndata: 1\r\n\r\nid: 2\rdata: é😀\r\rdata: 3\n\n: beat\n\ndata",
            "data: a\n\n\n\ndata: b\r\n\r\n\r\ndata: €\r",
            "id: x\n\nevent: y\ndata:\ndata:  two\r\n",
        ];
        for (const text of texts) {
            const bytes = encoder.encode(text);
            for (let cut = 0; cut <= bytes.length; cut += 1) {
                const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
                expect(await collect(bytesStreamOf(chunks))).toEqual(
                    await collect(bytesStreamOf(chunks), readSseFramesReference),
                );
            }
            expect(await collect(bytesStreamOf(eachByte(bytes)))).toEqual(
                await collect(bytesStreamOf(eachByte(bytes)), readSseFramesReference),
            );
        }
    });

    it("frames random streams cut at random points as the reference framing does", async () => {
        const encoder = new TextEncoder();
        for (let seed = 1; seed <= 2_000; seed += 1) {
            const random = randomFrom(seed);
            const bytes = encoder.encode(randomSseText(random));
            const chunkings = [
                [bytes],
                eachByte(bytes),
                randomChunks(bytes, random),
                randomChunks(bytes, random),
            ];
            for (const chunks of chunkings) {
                const expected = await collect(bytesStreamOf(chunks), readSseFramesReference);
                expect(await collect(bytesStreamOf(chunks)), `seed ${seed}`).toEqual(expected);
            }
        }
    });
});
