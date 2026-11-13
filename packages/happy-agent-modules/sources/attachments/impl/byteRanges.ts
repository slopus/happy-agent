import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ByteRange } from "../Attachment.js";

const byteRangesSchema = Type.Array(
    Type.Object(
        { start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
    ),
);

/** Stored ranges, checked: a row that does not hold them is a broken database. */
export function parseByteRanges(json: string): ByteRange[] {
    const parsed: unknown = JSON.parse(json);
    if (!Value.Check(byteRangesSchema, parsed)) {
        throw new Error("A stored attachment upload holds invalid byte ranges.");
    }
    return parsed;
}

/** `ranges`, in order and merged, with `added` included. Touching ranges merge too. */
export function addByteRange(ranges: readonly ByteRange[], added: ByteRange): ByteRange[] {
    const sorted = [...ranges, added].sort((left, right) => left.start - right.start);
    const merged: ByteRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (last !== undefined && range.start <= last.end + 1) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
        } else {
            merged.push(range);
        }
    }
    return merged;
}

/** Whether merged ranges hold every byte of a file of `size` bytes. */
export function byteRangesComplete(ranges: readonly ByteRange[], size: number): boolean {
    const [only] = ranges;
    return ranges.length === 1 && only !== undefined && only.start === 0 && only.end === size - 1;
}
