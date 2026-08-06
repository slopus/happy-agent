import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import type { P2pFrameDuplex, P2pFrameReader, P2pFrameWriter } from "./P2pFrameDuplex.js";
import { readP2pTunnelFrame, type P2pTunnelFrame } from "./P2pTunnelProtocol.js";
import { createP2pTunnelStream } from "./P2pTunnelStream.js";

describe("P2P tunnel stream", () => {
    it("carries bytes both ways and ends on the peer's end-of-stream frame", async () => {
        const pipe = createFramePipe();
        const left = createP2pTunnelStream(pipe.left);
        const right = createP2pTunnelStream(pipe.right);

        left.write("ping");
        left.end();
        await expect(collect(right)).resolves.toBe("ping");

        right.write("pong");
        right.end();
        await expect(collect(left)).resolves.toBe("pong");
    });

    it("splits one write into bounded frames", async () => {
        const pipe = createFramePipe();
        const left = createP2pTunnelStream(pipe.left, { maximumFrameBytes: 2 });

        left.write(Buffer.from("abcde"));
        left.end();

        await expect(readFrames(pipe.right.recv, 8)).resolves.toEqual([
            { bytes: bytesOf("ab"), type: "chunk" },
            { bytes: bytesOf("cd"), type: "chunk" },
            { bytes: bytesOf("e"), type: "chunk" },
            { type: "end" },
        ]);
    });

    it("keeps write order while the transport accepts writes partially", async () => {
        const wire = new MemoryWire({ writeLimit: 3 });
        const stream = createP2pTunnelStream({ recv: stalledReader(), send: wire.send });

        stream.write("first");
        stream.write("second");
        stream.end();
        await once(stream, "finish");

        await expect(readFrames(wire.recv(), 64)).resolves.toEqual([
            { bytes: bytesOf("first"), type: "chunk" },
            { bytes: bytesOf("second"), type: "chunk" },
            { type: "end" },
        ]);
    });

    it("reads no further than the consumer asks for", async () => {
        const wire = new MemoryWire({ writeLimit: 1024 });
        await writeFrames(wire.send, ["aaaa", "bbbb", "cccc", "dddd"]);
        const recv = wire.recv();
        const stream = createP2pTunnelStream(
            { recv, send: new MemoryWire({ writeLimit: 1024 }).send },
            { highWaterMark: 1 },
        );

        stream.on("readable", () => undefined);
        await settle();
        expect(recv.framesConsumed).toBeLessThanOrEqual(2);

        await expect(drain(stream)).resolves.toBe("aaaabbbbccccdddd");
    });

    it("destroys the stream with the message the peer sent", async () => {
        const wire = new MemoryWire({ writeLimit: 1024 });
        await writeFrames(wire.send, [], "The peer lost its terminal.");
        const stream = createP2pTunnelStream({ recv: wire.recv(), send: wire.send });

        stream.resume();

        const [error] = (await once(stream, "error")) as [Error];
        expect(error.message).toBe("The peer lost its terminal.");
        expect(stream.destroyed).toBe(true);
    });

    it("cancels through an abort signal and releases the transport", async () => {
        const controller = new AbortController();
        let closed = false;
        const stream = createP2pTunnelStream(
            { recv: stalledReader(), send: new MemoryWire({ writeLimit: 1024 }).send },
            {
                close: () => {
                    closed = true;
                },
                signal: controller.signal,
            },
        );
        stream.resume();

        controller.abort(new Error("The user closed the terminal."));

        const [error] = (await once(stream, "error")) as [Error];
        expect(error.message).toBe("The user closed the terminal.");
        expect(closed).toBe(true);
    });

    it("releases the transport once both directions finish", async () => {
        const pipe = createFramePipe();
        let closed = false;
        const left = createP2pTunnelStream(pipe.left, {
            close: () => {
                closed = true;
            },
        });
        const right = createP2pTunnelStream(pipe.right);
        const leftClosed = once(left, "close");

        left.end();
        right.end();
        await Promise.all([collect(left), collect(right)]);
        await leftClosed;

        expect(closed).toBe(true);
    });

    it("fails a write when the peer stops reading", async () => {
        const stalledSend: P2pFrameWriter = {
            finish: async () => undefined,
            write: () => new Promise<number>(() => undefined),
        };
        const stream = createP2pTunnelStream(
            { recv: stalledReader(), send: stalledSend },
            { writeProgressTimeoutMs: 5 },
        );

        stream.write("payload");

        const [error] = (await once(stream, "error")) as [Error];
        expect(error.message).toMatch("stopped reading");
    });
});

function createFramePipe(): { left: P2pFrameDuplex; right: P2pFrameDuplex } {
    const toRight = new PassThrough();
    const toLeft = new PassThrough();
    return {
        left: createNodeFrameDuplex(toLeft, toRight),
        right: createNodeFrameDuplex(toRight, toLeft),
    };
}

/**
 * Collects the readable side by event. Iterating a duplex destroys it at end of
 * stream, which would defeat the half-open behaviour these tests check.
 */
function collect(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
        stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.once("error", reject);
    });
}

/** Drains a paused readable, which is the only safe style once it has a `readable` listener. */
async function drain(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for (let round = 0; round < 32 && !stream.readableEnded; round += 1) {
        for (let chunk = stream.read() as Buffer | null; chunk !== null; chunk = stream.read()) {
            chunks.push(Buffer.from(chunk));
        }
        await settle();
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function readFrames(recv: P2pFrameReader, limit: number): Promise<P2pTunnelFrame[]> {
    const frames: P2pTunnelFrame[] = [];
    for (let index = 0; index < limit; index += 1) {
        const frame = await readP2pTunnelFrame(recv);
        frames.push(frame);
        if (frame.type !== "chunk") return frames;
    }
    return frames;
}

async function writeFrames(
    send: P2pFrameWriter,
    payloads: readonly string[],
    errorMessage?: string,
): Promise<void> {
    for (const payload of payloads) {
        const bytes = Buffer.from(payload, "utf8");
        const frame = Buffer.alloc(5 + bytes.byteLength);
        frame.writeUInt8(1, 0);
        frame.writeUInt32BE(bytes.byteLength, 1);
        bytes.copy(frame, 5);
        await send.write(frame);
    }
    if (errorMessage === undefined) {
        await send.write(Uint8Array.of(2));
        return;
    }
    const head = Buffer.from(JSON.stringify({ message: errorMessage }), "utf8");
    const frame = Buffer.alloc(5 + head.byteLength);
    frame.writeUInt8(3, 0);
    frame.writeUInt32BE(head.byteLength, 1);
    head.copy(frame, 5);
    await send.write(frame);
}

function bytesOf(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf8"));
}

function stalledReader(): P2pFrameReader {
    return { read: () => new Promise<Uint8Array>(() => undefined) };
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await new Promise(setImmediate);
}

interface CountingReader extends P2pFrameReader {
    framesConsumed: number;
}

class MemoryWire {
    readonly #chunks: number[] = [];
    readonly #writeLimit: number;

    constructor(options: { writeLimit: number }) {
        this.#writeLimit = options.writeLimit;
    }

    readonly send: P2pFrameWriter = {
        finish: async () => undefined,
        write: async (bytes: Uint8Array) => {
            const written = Math.min(bytes.byteLength, this.#writeLimit);
            this.#chunks.push(...bytes.subarray(0, written));
            return written;
        },
    };

    recv(): CountingReader {
        let offset = 0;
        const reader: CountingReader = {
            framesConsumed: 0,
            read: async (length: number) => {
                const result = this.#chunks.slice(offset, offset + length);
                if (result.length !== length) {
                    return await new Promise<Uint8Array>(() => undefined);
                }
                offset += length;
                if (length === 1) reader.framesConsumed += 1;
                return Uint8Array.from(result);
            },
        };
        return reader;
    }
}
