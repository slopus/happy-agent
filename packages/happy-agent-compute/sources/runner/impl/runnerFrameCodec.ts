import { Value } from "@sinclair/typebox/value";

import { RunnerFrameTooLargeError, RunnerProtocolError } from "../RunnerErrors.js";
import {
    MAX_RUNNER_FRAME_BYTES,
    runnerFrameHeaderSchema,
    type RunnerFrameHeader,
} from "../runnerProtocol.js";

/** One decoded frame: its JSON header and, for the methods that carry bytes, a body. */
export interface RunnerFrame {
    readonly header: RunnerFrameHeader;
    readonly body?: Uint8Array;
}

const HEADER_LENGTH_BYTES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Lay a frame out as a 32-bit big-endian header length, the UTF-8 JSON header, and the raw body.
 *
 * Bytes travel outside the JSON so a file read or written through a runner costs its own size on the
 * wire rather than a third more as base64.
 */
export function encodeRunnerFrame(header: RunnerFrameHeader, body?: Uint8Array): Uint8Array {
    const headerBytes = encoder.encode(JSON.stringify(header));
    const bodyLength = body?.byteLength ?? 0;
    const total = HEADER_LENGTH_BYTES + headerBytes.byteLength + bodyLength;
    if (total > MAX_RUNNER_FRAME_BYTES) {
        throw new RunnerFrameTooLargeError(total);
    }
    const frame = new Uint8Array(total);
    new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
    frame.set(headerBytes, HEADER_LENGTH_BYTES);
    if (body !== undefined) frame.set(body, HEADER_LENGTH_BYTES + headerBytes.byteLength);
    return frame;
}

/**
 * Read a frame received from the other side, refusing anything malformed.
 *
 * Nothing that arrives is trusted: a runner may be a compromised machine, and a daemon may be an
 * impostor until the transport proved otherwise. A frame that is too large, whose header is not
 * UTF-8 JSON, or whose header is not one of the protocol's frames is an error rather than a guess.
 */
export function decodeRunnerFrame(frame: Uint8Array): RunnerFrame {
    if (frame.byteLength > MAX_RUNNER_FRAME_BYTES) {
        throw new RunnerProtocolError(
            "The other side sent a frame larger than the protocol allows.",
        );
    }
    if (frame.byteLength < HEADER_LENGTH_BYTES) {
        throw new RunnerProtocolError("The other side sent a frame without a header.");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerLength = view.getUint32(0, false);
    const bodyOffset = HEADER_LENGTH_BYTES + headerLength;
    if (bodyOffset > frame.byteLength) {
        throw new RunnerProtocolError("The other side sent a frame whose header was cut short.");
    }
    let header: unknown;
    try {
        header = JSON.parse(decoder.decode(frame.subarray(HEADER_LENGTH_BYTES, bodyOffset)));
    } catch {
        throw new RunnerProtocolError("The other side sent a frame header that is not JSON.");
    }
    if (!Value.Check(runnerFrameHeaderSchema, header)) {
        throw new RunnerProtocolError("The other side sent a frame the protocol does not define.");
    }
    return bodyOffset === frame.byteLength ? { header } : { header, body: frame.slice(bodyOffset) };
}
