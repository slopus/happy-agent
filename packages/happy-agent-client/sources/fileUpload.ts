import { sha256 } from "@noble/hashes/sha2.js";

import { HappyAgentApiError } from "./HappyAgentApiError.js";
import { HappyAgentUploadLimitError } from "./HappyAgentUploadLimitError.js";

import {
    ATTACHMENT_MAX_CHUNKS,
    ATTACHMENT_MAX_REQUEST,
    ATTACHMENT_MAX_SIZE,
    type AttachmentUpload,
} from "./protocol/attachments.js";
import type {
    AttachFileOptions,
    AttachmentChunk,
    FileUpload,
    FileUploadSource,
} from "./requestOptions.js";

/** Defaults are shared by the media and older attachment upload paths. */
const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

type UploadReply<T> = { complete: T } | { upload: AttachmentUpload };

/** The HTTP adapter supplies the same upload protocol under either response envelope. */
export interface FileUploadTransport<T> {
    whole(data: Uint8Array<ArrayBuffer>): Promise<T>;
    chunk(id: string, chunk: AttachmentChunk): Promise<UploadReply<T>>;
}

/**
 * Read and hash at most one chunk at a time with portable incremental SHA-256. No automatic
 * retries: a caller repeats the operation to resume. Hash mismatches remain HappyAgentApiErrors;
 * local and persisted request limits become HappyAgentUploadLimitErrors. Never discard a shared
 * upload another client may be using just to recover from an error.
 */
export async function fileUpload<T>(
    file: FileUpload,
    options: AttachFileOptions,
    transport: FileUploadTransport<T>,
): Promise<T> {
    const source = sourceOf(file.data);
    const chunkSize = options.chunkSize ?? UPLOAD_CHUNK_SIZE;
    const directLimit = options.directLimit ?? UPLOAD_CHUNK_SIZE;
    if (
        !Number.isSafeInteger(source.size) ||
        source.size < 0 ||
        source.size > ATTACHMENT_MAX_SIZE
    ) {
        throw new RangeError("A media upload must be between zero bytes and 1 GiB.");
    }
    if (
        !Number.isSafeInteger(chunkSize) ||
        chunkSize < 1 ||
        chunkSize > ATTACHMENT_MAX_REQUEST ||
        !Number.isSafeInteger(directLimit) ||
        directLimit < 0 ||
        directLimit > ATTACHMENT_MAX_REQUEST
    ) {
        throw new RangeError(
            "Upload chunk size must be between 1 byte and 25 MiB, and the whole-file limit between zero and 25 MiB.",
        );
    }
    const { signal } = options;
    const chunk = { name: file.name, size: source.size, contentType: file.contentType };
    signal?.throwIfAborted();
    options.onProgress?.(0, source.size);
    if (source.size <= directLimit) {
        const bytes = await read(source, 0, source.size, signal);
        signal?.throwIfAborted();
        const complete = await transport.whole(bytes);
        options.onProgress?.(source.size, source.size);
        return complete;
    }

    const hash = sha256.create();
    let id: string;
    try {
        options.onHashProgress?.(0, source.size);
        for (let start = 0; start < source.size; ) {
            const end = Math.min(source.size, start + UPLOAD_CHUNK_SIZE);
            hash.update(await read(source, start, end, signal));
            start = end;
            options.onHashProgress?.(start, source.size);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            signal?.throwIfAborted();
        }
        id = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } finally {
        hash.destroy();
    }

    signal?.throwIfAborted();
    // The daemon currently reports its persisted request cap as generic invalid_request.
    // Recognize that response across numeric cap changes; other bad requests keep their API error.
    const sendChunk = async (part: AttachmentChunk): Promise<UploadReply<T>> => {
        try {
            return await transport.chunk(id, part);
        } catch (error) {
            if (
                error instanceof HappyAgentApiError &&
                error.status === 400 &&
                error.code === "invalid_request" &&
                /^An upload takes at most \d+ requests (?:carrying|with) bytes/u.test(error.message)
            ) {
                throw new HappyAgentUploadLimitError({ cause: error });
            }
            throw error;
        }
    };
    const first = await read(source, 0, Math.min(source.size, chunkSize), signal);
    signal?.throwIfAborted();
    let reply = await sendChunk({ ...chunk, start: 0, data: first });
    let previous = -1;
    let requests = 1;
    while (!("complete" in reply)) {
        const upload = reply.upload;
        if (upload.id !== id || upload.size !== source.size) {
            throw new Error("The daemon answered with a different upload; start the upload again.");
        }
        let received = 0;
        let start = 0;
        for (const range of upload.received) {
            received += range.end - range.start + 1;
            if (range.start <= start) start = Math.max(start, range.end + 1);
        }
        if (received <= previous || start >= source.size) {
            throw new Error("The daemon did not keep the uploaded bytes; upload the file again.");
        }
        previous = received;
        options.onProgress?.(received, source.size);
        if (requests >= ATTACHMENT_MAX_CHUNKS) {
            throw new HappyAgentUploadLimitError();
        }
        const next = upload.received.find((range) => range.start > start)?.start ?? source.size;
        const end = Math.min(next, start + chunkSize, source.size);
        const bytes = await read(source, start, end, signal);
        signal?.throwIfAborted();
        requests += 1;
        reply = await sendChunk({ ...chunk, start, data: bytes });
    }
    options.onProgress?.(source.size, source.size);
    return reply.complete;
}

/** Native byte sources are normalized without taking a whole-file copy. */
function sourceOf(data: FileUpload["data"]): FileUploadSource {
    if (data instanceof Uint8Array) {
        return { size: data.byteLength, read: async (start, end) => data.subarray(start, end) };
    }
    if (data instanceof Blob) {
        return {
            size: data.size,
            read: async (start, end) => new Uint8Array(await data.slice(start, end).arrayBuffer()),
        };
    }
    return { size: data.size, read: (start, end) => data.read(start, end) };
}

/** Abort promptly even if a custom source's pending read cannot itself be cancelled. */
async function read(
    source: FileUploadSource,
    start: number,
    end: number,
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    let aborted: (() => void) | undefined;
    let bytes: Uint8Array;
    try {
        bytes = await new Promise<Uint8Array>((resolve, reject) => {
            aborted = () => reject(signal?.reason);
            signal?.addEventListener("abort", aborted, { once: true });
            Promise.resolve()
                .then(() => {
                    signal?.throwIfAborted();
                    return source.read(start, end);
                })
                .then(resolve, reject);
        });
    } finally {
        if (aborted !== undefined) signal?.removeEventListener("abort", aborted);
    }
    signal?.throwIfAborted();
    if (bytes.byteLength !== end - start) {
        throw new Error(
            "The upload source returned the wrong number of bytes; the file may have changed.",
        );
    }
    return new Uint8Array(bytes);
}
