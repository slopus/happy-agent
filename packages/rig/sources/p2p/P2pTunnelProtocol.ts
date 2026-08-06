import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    finishWrites,
    writeBytes,
    type P2pFrameReader,
    type P2pFrameWriter,
} from "./P2pFrameDuplex.js";
import {
    P2P_TUNNEL_MAXIMUM_FRAME_BYTES,
    P2P_TUNNEL_MAXIMUM_HEAD_BYTES,
    p2pTunnelRequestHeadSchema,
    p2pTunnelResponseHeadSchema,
    type P2pTunnelRequestHead,
    type P2pTunnelResponseHead,
} from "./P2pTunnel.js";

/**
 * The tunnel wire format, on top of any `P2pFrameDuplex`.
 *
 * ```text
 * initiator: <request head>  then  frames...
 * responder: <accept|error>  then  frames...
 * frame:     CHUNK u32 length bytes | END | ERROR <message head>
 * ```
 *
 * Both directions frame independently, so either side may reach end of stream
 * while the other keeps sending — the half-open behaviour a socket has.
 */

const FRAME_CHUNK = 1;
const FRAME_END = 2;
const FRAME_ERROR = 3;
const DEFAULT_WRITE_PROGRESS_TIMEOUT_MS = 30_000;

const errorSchema = Type.Object(
    { message: Type.String({ maxLength: 4 * 1024, minLength: 1 }) },
    { additionalProperties: false },
);

export type P2pTunnelFrame =
    | { readonly bytes: Uint8Array; readonly type: "chunk" }
    | { readonly message: string; readonly type: "error" }
    | { readonly type: "end" };

export async function writeP2pTunnelRequest(
    send: P2pFrameWriter,
    head: P2pTunnelRequestHead,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeJson(send, head, p2pTunnelRequestHeadSchema, writeProgressTimeoutMs);
}

export async function readP2pTunnelRequest(recv: P2pFrameReader): Promise<P2pTunnelRequestHead> {
    return await readJson(recv, p2pTunnelRequestHeadSchema);
}

/** Accepts a tunnel. Raw bytes follow immediately in both directions. */
export async function writeP2pTunnelResponse(
    send: P2pFrameWriter,
    head: P2pTunnelResponseHead,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeU8(send, FRAME_CHUNK, writeProgressTimeoutMs);
    await writeJson(send, head, p2pTunnelResponseHeadSchema, writeProgressTimeoutMs);
}

export async function readP2pTunnelResponse(recv: P2pFrameReader): Promise<P2pTunnelResponseHead> {
    const tag = await readU8(recv);
    if (tag === FRAME_ERROR) throw new Error((await readJson(recv, errorSchema)).message);
    if (tag !== FRAME_CHUNK) throw new Error("The peer returned an invalid tunnel response.");
    return await readJson(recv, p2pTunnelResponseHeadSchema);
}

/** Refuses a tunnel before it carries any bytes, and closes the send side. */
export async function writeP2pTunnelFailure(
    send: P2pFrameWriter,
    error: unknown,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeP2pTunnelError(send, error, writeProgressTimeoutMs);
    await finishWrites(send, writeProgressTimeoutMs);
}

export async function writeP2pTunnelChunk(
    send: P2pFrameWriter,
    bytes: Uint8Array,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > P2P_TUNNEL_MAXIMUM_FRAME_BYTES) {
        throw new Error("A tunnel frame is too large.");
    }
    await writeU8(send, FRAME_CHUNK, writeProgressTimeoutMs);
    await writeU32(send, bytes.byteLength, writeProgressTimeoutMs);
    await writeBytes(send, bytes, writeProgressTimeoutMs);
}

export async function writeP2pTunnelEnd(
    send: P2pFrameWriter,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    await writeU8(send, FRAME_END, writeProgressTimeoutMs);
}

export async function writeP2pTunnelError(
    send: P2pFrameWriter,
    error: unknown,
    writeProgressTimeoutMs = DEFAULT_WRITE_PROGRESS_TIMEOUT_MS,
): Promise<void> {
    const message =
        error instanceof Error && error.message.length > 0
            ? error.message.slice(0, 4 * 1024)
            : "The peer could not keep the tunnel open.";
    await writeU8(send, FRAME_ERROR, writeProgressTimeoutMs);
    await writeJson(send, { message }, errorSchema, writeProgressTimeoutMs);
}

export async function readP2pTunnelFrame(
    recv: P2pFrameReader,
    maximumFrameBytes = P2P_TUNNEL_MAXIMUM_FRAME_BYTES,
): Promise<P2pTunnelFrame> {
    const tag = await readU8(recv);
    if (tag === FRAME_END) return { type: "end" };
    if (tag === FRAME_ERROR) {
        return { message: (await readJson(recv, errorSchema)).message, type: "error" };
    }
    if (tag !== FRAME_CHUNK) throw new Error("The peer sent an invalid tunnel frame.");
    const length = await readU32(recv);
    if (length === 0 || length > maximumFrameBytes) {
        throw new Error("The peer sent an oversized tunnel frame.");
    }
    return { bytes: await recv.read(length), type: "chunk" };
}

async function readJson<Schema extends TSchema>(
    recv: P2pFrameReader,
    schema: Schema,
): Promise<Static<Schema>> {
    const length = await readU32(recv);
    if (length === 0 || length > P2P_TUNNEL_MAXIMUM_HEAD_BYTES) {
        throw new Error("The peer sent an invalid tunnel header.");
    }
    const source = Buffer.from(await recv.read(length)).toString("utf8");
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error("The peer sent malformed tunnel metadata.");
    }
    return Value.Decode(schema, value) as Static<Schema>;
}

async function writeJson<Schema extends TSchema>(
    send: P2pFrameWriter,
    value: Static<Schema>,
    schema: Schema,
    writeProgressTimeoutMs: number,
): Promise<void> {
    if (!Value.Check(schema, value)) {
        throw new Error("Tunnel metadata is invalid.");
    }
    const encoded = Buffer.from(JSON.stringify(Value.Encode(schema, value)), "utf8");
    if (encoded.byteLength === 0 || encoded.byteLength > P2P_TUNNEL_MAXIMUM_HEAD_BYTES) {
        throw new Error("Tunnel metadata is too large.");
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
