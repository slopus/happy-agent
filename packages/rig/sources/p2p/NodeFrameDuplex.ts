import type { Readable, Writable } from "node:stream";

import type { P2pFrameDuplex, P2pFrameReader, P2pFrameWriter } from "./P2pFrameDuplex.js";

export function createNodeFrameDuplex(recv: Readable, send: Writable): P2pFrameDuplex {
    return {
        recv: new NodeFrameReader(recv),
        send: new NodeFrameWriter(send),
    };
}

class NodeFrameReader implements P2pFrameReader {
    readonly #iterator: AsyncIterator<unknown>;
    #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    #reading = false;

    constructor(stream: Readable) {
        this.#iterator = stream[Symbol.asyncIterator]();
    }

    async read(length: number): Promise<Uint8Array> {
        if (!Number.isSafeInteger(length) || length < 0) {
            throw new Error("A P2P frame read length must be a non-negative integer.");
        }
        if (this.#reading) throw new Error("Concurrent reads from one P2P stream are not allowed.");
        this.#reading = true;
        try {
            while (this.#buffer.byteLength < length) {
                const next = await this.#iterator.next();
                if (next.done)
                    throw new Error("The P2P stream ended before its frame was complete.");
                const chunk = Buffer.isBuffer(next.value)
                    ? next.value
                    : Buffer.from(next.value as Uint8Array);
                if (chunk.byteLength === 0) continue;
                this.#buffer =
                    this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
            }
            const result = this.#buffer.subarray(0, length);
            this.#buffer = this.#buffer.subarray(length);
            return new Uint8Array(result);
        } finally {
            this.#reading = false;
        }
    }
}

class NodeFrameWriter implements P2pFrameWriter {
    readonly #stream: Writable;

    constructor(stream: Writable) {
        this.#stream = stream;
    }

    finish(): Promise<void> {
        // The shared protocol is self-delimiting. Iroh needs a native half-close after each
        // one-shot bi-stream, while TLS and SSH keep one duplex open through hello and response.
        return Promise.resolve();
    }

    write(bytes: Uint8Array): Promise<number> {
        return new Promise((resolve, reject) => {
            const failed = (error: Error) => {
                cleanup();
                reject(error);
            };
            const closed = () => {
                cleanup();
                reject(new Error("The P2P stream closed before its write completed."));
            };
            const drained = () => {
                cleanup();
                resolve(bytes.byteLength);
            };
            const cleanup = () => {
                this.#stream.off("close", closed);
                this.#stream.off("drain", drained);
                this.#stream.off("error", failed);
            };
            this.#stream.once("close", closed);
            this.#stream.once("error", failed);
            if (this.#stream.write(bytes)) {
                cleanup();
                resolve(bytes.byteLength);
                return;
            }
            this.#stream.once("drain", drained);
        });
    }
}
