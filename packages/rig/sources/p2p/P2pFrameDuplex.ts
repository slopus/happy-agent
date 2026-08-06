import type { RecvStream, SendStream } from "@number0/iroh/index.js";

/** Largest byte run handed to a transport in one read or write. */
export const P2P_MAXIMUM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_WRITE_PROGRESS_TIMEOUT_MS = 30_000;

/**
 * The byte-level stream pair every P2P transport provides.
 *
 * A transport supplies exact-length reads and partial writes; everything above
 * this interface — the signed hello and the framed HTTP protocol — is written
 * against it and never against a transport's native stream type.
 */
export interface P2pFrameReader {
    /** Reads exactly `length` bytes, rejecting when the stream ends early. */
    read(length: number): Promise<Uint8Array>;
}

export interface P2pFrameWriter {
    finish(): Promise<void>;
    /** Writes up to `bytes.byteLength` bytes, returning how many were accepted. */
    write(bytes: Uint8Array): Promise<number>;
}

export interface P2pFrameDuplex {
    readonly recv: P2pFrameReader;
    readonly send: P2pFrameWriter;
}

export class P2pFrameWriteTimeoutError extends Error {}

export function createIrohFrameReader(recv: RecvStream): P2pFrameReader {
    return {
        read: async (length) => new Uint8Array(await recv.readExact(length)),
    };
}

export function createIrohFrameWriter(send: SendStream): P2pFrameWriter {
    return {
        finish: () => send.finish(),
        write: (bytes) => send.write([...bytes]),
    };
}

export function createIrohFrameDuplex(recv: RecvStream, send: SendStream): P2pFrameDuplex {
    return { recv: createIrohFrameReader(recv), send: createIrohFrameWriter(send) };
}

export async function readBytes(recv: P2pFrameReader, length: number): Promise<Uint8Array> {
    const body = new Uint8Array(length);
    for (let offset = 0; offset < length; ) {
        const chunkLength = Math.min(length - offset, P2P_MAXIMUM_CHUNK_BYTES);
        body.set(await recv.read(chunkLength), offset);
        offset += chunkLength;
    }
    return body;
}

export async function writeBytes(
    send: P2pFrameWriter,
    bytes: Uint8Array,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; ) {
        const chunk = bytes.subarray(
            offset,
            Math.min(offset + P2P_MAXIMUM_CHUNK_BYTES, bytes.byteLength),
        );
        const written = await withWriteProgressDeadline(send.write(chunk), writeProgressTimeoutMs);
        if (written <= 0 || written > chunk.byteLength) {
            throw new Error("The P2P stream stopped accepting data.");
        }
        offset += written;
    }
}

export async function finishWrites(
    send: P2pFrameWriter,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await withWriteProgressDeadline(send.finish(), writeProgressTimeoutMs);
}

export function withWriteProgressDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(new P2pFrameWriteTimeoutError("The peer stopped reading the P2P response.")),
            timeoutMs,
        );
        void operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
