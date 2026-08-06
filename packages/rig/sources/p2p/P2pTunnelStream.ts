import { Duplex } from "node:stream";

import { finishWrites, type P2pFrameDuplex } from "./P2pFrameDuplex.js";
import { P2P_TUNNEL_MAXIMUM_FRAME_BYTES } from "./P2pTunnel.js";
import { readP2pTunnelFrame, writeP2pTunnelChunk, writeP2pTunnelEnd } from "./P2pTunnelProtocol.js";

const DEFAULT_WRITE_PROGRESS_TIMEOUT_MS = 30_000;

export interface P2pTunnelStreamOptions {
    /**
     * Tears down the underlying transport stream once the tunnel settles. A
     * read parked on the transport only unblocks when the transport closes, so
     * every caller should release its stream here.
     */
    close?: () => void;
    /** Bytes buffered in each direction before the stream applies backpressure. */
    highWaterMark?: number;
    /** Largest payload written in one frame. Never above the protocol bound. */
    maximumFrameBytes?: number;
    /** Cancels the tunnel and destroys the stream. */
    signal?: AbortSignal;
    /** How long one transport write may make no progress before it fails. */
    writeProgressTimeoutMs?: number;
}

/**
 * Presents a `P2pFrameDuplex` as an ordinary Node duplex stream.
 *
 * Everything a socket-shaped consumer expects holds: bytes flow both ways,
 * `end()` sends the tunnel's end-of-stream frame, the peer's end-of-stream
 * frame ends the readable side, and either side's failure destroys the stream
 * with the reason rather than truncating it silently.
 *
 * Nothing accumulates. Reads happen only while the consumer wants data, writes
 * are serialized one frame at a time and never queued behind the transport, and
 * every frame is bounded.
 *
 * The head — {@link writeP2pTunnelRequest} and {@link writeP2pTunnelResponse} —
 * is exchanged on the same duplex before this stream is created.
 */
export function createP2pTunnelStream(
    duplex: P2pFrameDuplex,
    options: P2pTunnelStreamOptions = {},
): Duplex {
    return new P2pTunnelStream(duplex, options);
}

class P2pTunnelStream extends Duplex {
    readonly #close: (() => void) | undefined;
    readonly #duplex: P2pFrameDuplex;
    readonly #maximumFrameBytes: number;
    readonly #signal: AbortSignal | undefined;
    readonly #writeProgressTimeoutMs: number;
    readonly #onAbort = () => {
        this.destroy(abortError(this.#signal?.reason));
    };
    #closed = false;
    #pumping = false;
    #readEnded = false;
    #wantsData = false;
    #writes: Promise<void> = Promise.resolve();

    constructor(duplex: P2pFrameDuplex, options: P2pTunnelStreamOptions) {
        super({
            allowHalfOpen: true,
            ...(options.highWaterMark === undefined
                ? {}
                : { highWaterMark: options.highWaterMark }),
        });
        this.#close = options.close;
        this.#duplex = duplex;
        this.#maximumFrameBytes = Math.min(
            options.maximumFrameBytes ?? P2P_TUNNEL_MAXIMUM_FRAME_BYTES,
            P2P_TUNNEL_MAXIMUM_FRAME_BYTES,
        );
        this.#signal = options.signal;
        this.#writeProgressTimeoutMs =
            options.writeProgressTimeoutMs ?? DEFAULT_WRITE_PROGRESS_TIMEOUT_MS;
        if (this.#signal !== undefined) {
            if (this.#signal.aborted) queueMicrotask(this.#onAbort);
            else this.#signal.addEventListener("abort", this.#onAbort, { once: true });
        }
    }

    override _read(): void {
        this.#wantsData = true;
        void this.#pump();
    }

    override _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error) => void,
    ): void {
        const bytes = toBytes(chunk);
        this.#enqueue(async () => {
            for (let offset = 0; offset < bytes.byteLength; offset += this.#maximumFrameBytes) {
                await writeP2pTunnelChunk(
                    this.#duplex.send,
                    bytes.subarray(
                        offset,
                        Math.min(offset + this.#maximumFrameBytes, bytes.byteLength),
                    ),
                    this.#writeProgressTimeoutMs,
                );
            }
        }, callback);
    }

    override _final(callback: (error?: Error) => void): void {
        this.#enqueue(async () => {
            await writeP2pTunnelEnd(this.#duplex.send, this.#writeProgressTimeoutMs);
            await finishWrites(this.#duplex.send, this.#writeProgressTimeoutMs);
        }, callback);
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.#signal?.removeEventListener("abort", this.#onAbort);
        this.#wantsData = false;
        if (!this.#closed) {
            this.#closed = true;
            this.#close?.();
        }
        callback(error);
    }

    #enqueue(operation: () => Promise<void>, callback: (error?: Error) => void): void {
        const settled = this.#writes.then(operation);
        this.#writes = settled.then(
            () => undefined,
            () => undefined,
        );
        void settled.then(
            () => callback(),
            (error: unknown) => callback(asError(error)),
        );
    }

    async #pump(): Promise<void> {
        if (this.#pumping) return;
        this.#pumping = true;
        try {
            while (this.#wantsData && !this.#readEnded && !this.destroyed) {
                const frame = await readP2pTunnelFrame(this.#duplex.recv, this.#maximumFrameBytes);
                if (this.destroyed) return;
                if (frame.type === "end") {
                    this.#readEnded = true;
                    this.push(null);
                    return;
                }
                if (frame.type === "error") throw new Error(frame.message);
                this.#wantsData = this.push(Buffer.from(frame.bytes));
            }
        } catch (error) {
            if (!this.destroyed) this.destroy(asError(error));
        } finally {
            this.#pumping = false;
        }
    }
}

function toBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === "string") return new Uint8Array(Buffer.from(chunk, "utf8"));
    if (chunk instanceof Uint8Array) return chunk;
    throw new Error("A P2P tunnel carries bytes only.");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function abortError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error("The P2P tunnel was cancelled.");
}
