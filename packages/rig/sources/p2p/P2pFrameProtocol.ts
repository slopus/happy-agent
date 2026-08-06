import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    P2P_MAXIMUM_CHUNK_BYTES,
    P2pFrameWriteTimeoutError,
    finishWrites,
    readBytes,
    writeBytes,
    type P2pFrameReader,
    type P2pFrameWriter,
} from "./P2pFrameDuplex.js";
import {
    P2P_HTTP_MAXIMUM_BODY_BYTES,
    p2pHttpRequestHeadSchema,
    p2pHttpResponseHeadSchema,
    type P2pHttpRequest,
    type P2pHttpResponse,
} from "./P2pHttp.js";

const FRAME_CHUNK = 1;
const FRAME_END = 2;
const FRAME_ERROR = 3;
const MAXIMUM_FRAME_BYTES = P2P_MAXIMUM_CHUNK_BYTES;
const MAXIMUM_HEAD_BYTES = P2P_MAXIMUM_CHUNK_BYTES;
const DEFAULT_WRITE_PROGRESS_TIMEOUT_MS = 30_000;
const errorSchema = Type.Object(
    { message: Type.String({ maxLength: 4 * 1024, minLength: 1 }) },
    { additionalProperties: false },
);
type ErrorFrame = Static<typeof errorSchema>;

export async function readP2pHttpRequest(recv: P2pFrameReader): Promise<P2pHttpRequest> {
    const head = await readJson(recv, p2pHttpRequestHeadSchema);
    const bodyLength = await readU32(recv);
    if (bodyLength > P2P_HTTP_MAXIMUM_BODY_BYTES) {
        throw new Error("The forwarded request body is too large.");
    }
    const body = await readBytes(recv, bodyLength);
    return { ...head, body };
}

export async function writeP2pHttpRequest(
    send: P2pFrameWriter,
    request: P2pHttpRequest,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    if (request.body.byteLength > P2P_HTTP_MAXIMUM_BODY_BYTES) {
        throw new Error("The forwarded request body is too large.");
    }
    await writeJson(
        send,
        { headers: request.headers, method: request.method, path: request.path },
        p2pHttpRequestHeadSchema,
        writeProgressTimeoutMs,
    );
    await writeU32(send, request.body.byteLength, writeProgressTimeoutMs);
    await writeBytes(send, request.body, writeProgressTimeoutMs);
    await finishWrites(send, writeProgressTimeoutMs);
}

export async function readP2pHttpResponse(
    recv: P2pFrameReader,
    close: () => void,
): Promise<P2pHttpResponse> {
    const firstFrame = await readU8(recv);
    if (firstFrame === FRAME_ERROR) throw new Error((await readError(recv)).message);
    if (firstFrame !== FRAME_CHUNK) throw new Error("The peer returned an invalid HTTP response.");
    const head = await readJson(recv, p2pHttpResponseHeadSchema);
    return {
        ...head,
        body: readResponseBody(recv, close),
    };
}

export async function writeP2pHttpResponse(
    send: P2pFrameWriter,
    response: P2pHttpResponse,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeU8(send, FRAME_CHUNK, writeProgressTimeoutMs);
    await writeJson(
        send,
        { headers: response.headers, status: response.status },
        p2pHttpResponseHeadSchema,
        writeProgressTimeoutMs,
    );
    try {
        for await (const chunk of response.body) {
            for (let offset = 0; offset < chunk.byteLength; offset += MAXIMUM_FRAME_BYTES) {
                const frame = chunk.subarray(
                    offset,
                    Math.min(offset + MAXIMUM_FRAME_BYTES, chunk.byteLength),
                );
                await writeU8(send, FRAME_CHUNK, writeProgressTimeoutMs);
                await writeU32(send, frame.byteLength, writeProgressTimeoutMs);
                await writeBytes(send, frame, writeProgressTimeoutMs);
            }
        }
        await writeU8(send, FRAME_END, writeProgressTimeoutMs);
    } catch (error) {
        if (error instanceof P2pFrameWriteTimeoutError) throw error;
        await writeU8(send, FRAME_ERROR, writeProgressTimeoutMs);
        await writeError(send, error, writeProgressTimeoutMs);
    }
    await finishWrites(send, writeProgressTimeoutMs);
}

export async function writeP2pHttpFailure(
    send: P2pFrameWriter,
    error: unknown,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeU8(send, FRAME_ERROR, writeProgressTimeoutMs);
    await writeError(send, error, writeProgressTimeoutMs);
    await finishWrites(send, writeProgressTimeoutMs);
}

async function* readResponseBody(
    recv: P2pFrameReader,
    close: () => void,
): AsyncIterable<Uint8Array> {
    try {
        while (true) {
            const frame = await readU8(recv);
            if (frame === FRAME_END) return;
            if (frame === FRAME_ERROR) throw new Error((await readError(recv)).message);
            if (frame !== FRAME_CHUNK) {
                throw new Error("The peer returned an invalid HTTP response frame.");
            }
            const length = await readU32(recv);
            if (length > MAXIMUM_FRAME_BYTES) {
                throw new Error("The peer returned an oversized HTTP response frame.");
            }
            if (length > 0) yield await recv.read(length);
        }
    } finally {
        close();
    }
}

async function readError(recv: P2pFrameReader): Promise<ErrorFrame> {
    return readJson(recv, errorSchema);
}

async function writeError(
    send: P2pFrameWriter,
    error: unknown,
    writeProgressTimeoutMs: number,
): Promise<void> {
    const message =
        error instanceof Error && error.message.length > 0
            ? error.message.slice(0, 4 * 1024)
            : "The peer could not finish the forwarded request.";
    await writeJson(send, { message }, errorSchema, writeProgressTimeoutMs);
}

async function readJson<Schema extends typeof p2pHttpRequestHeadSchema>(
    recv: P2pFrameReader,
    schema: Schema,
): Promise<Static<Schema>>;
async function readJson<Schema extends typeof p2pHttpResponseHeadSchema>(
    recv: P2pFrameReader,
    schema: Schema,
): Promise<Static<Schema>>;
async function readJson<Schema extends typeof errorSchema>(
    recv: P2pFrameReader,
    schema: Schema,
): Promise<Static<Schema>>;
async function readJson(
    recv: P2pFrameReader,
    schema: typeof errorSchema | typeof p2pHttpRequestHeadSchema | typeof p2pHttpResponseHeadSchema,
): Promise<unknown> {
    const length = await readU32(recv);
    if (length === 0 || length > MAXIMUM_HEAD_BYTES) {
        throw new Error("The peer returned an invalid P2P HTTP header.");
    }
    const source = Buffer.from(await recv.read(length)).toString("utf8");
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error("The peer returned malformed P2P HTTP metadata.");
    }
    return Value.Decode(schema, value);
}

async function writeJson(
    send: P2pFrameWriter,
    value: unknown,
    schema: typeof errorSchema | typeof p2pHttpRequestHeadSchema | typeof p2pHttpResponseHeadSchema,
    writeProgressTimeoutMs: number,
): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(Value.Encode(schema, value)), "utf8");
    if (encoded.byteLength === 0 || encoded.byteLength > MAXIMUM_HEAD_BYTES) {
        throw new Error("P2P HTTP metadata is too large.");
    }
    await writeU32(send, encoded.byteLength, writeProgressTimeoutMs);
    await writeBytes(send, encoded, writeProgressTimeoutMs);
}

async function readU8(recv: P2pFrameReader): Promise<number> {
    return (await recv.read(1))[0]!;
}

async function writeU8(
    send: P2pFrameWriter,
    value: number,
    writeProgressTimeoutMs: number,
): Promise<void> {
    await writeBytes(send, Uint8Array.of(value), writeProgressTimeoutMs);
}

async function readU32(recv: P2pFrameReader): Promise<number> {
    return Buffer.from(await recv.read(4)).readUInt32BE(0);
}

async function writeU32(
    send: P2pFrameWriter,
    value: number,
    writeProgressTimeoutMs: number,
): Promise<void> {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32BE(value, 0);
    await writeBytes(send, bytes, writeProgressTimeoutMs);
}
