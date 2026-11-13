import type { HeaderPairs } from "./forwardToLocalApi.js";

/** Binary frame types of the relay's computer-socket protocol, version 1. */
export const REQ_BODY = 1;
export const RES_BODY = 2;
export const RES_FULL = 3;
export const WS_TEXT = 4;
export const WS_BINARY = 5;

export const MAX_BODY_FRAME_BYTES = 65_536;
export const MAX_WS_MESSAGE_BYTES = 1_048_576;

export interface ResponseHead {
    readonly h: HeaderPairs;
    readonly s: number;
}

/** `[type u8][exchange id u32 BE][payload]`. */
export function dataFrame(type: number, id: number, payload: Uint8Array): Buffer {
    const frame = Buffer.allocUnsafe(5 + payload.byteLength);
    frame.writeUInt8(type, 0);
    frame.writeUInt32BE(id, 1);
    frame.set(payload, 5);
    return frame;
}

/** A whole response in one message: `[head length u32 BE][head JSON][body]` as the payload. */
export function wholeResponseFrame(id: number, head: ResponseHead, body: Uint8Array): Buffer {
    const json = Buffer.from(JSON.stringify(head), "utf8");
    const frame = Buffer.allocUnsafe(9 + json.byteLength + body.byteLength);
    frame.writeUInt8(RES_FULL, 0);
    frame.writeUInt32BE(id, 1);
    frame.writeUInt32BE(json.byteLength, 5);
    frame.set(json, 9);
    frame.set(body, 9 + json.byteLength);
    return frame;
}
