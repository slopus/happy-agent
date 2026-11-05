import { Value } from "@sinclair/typebox/value";
import type { TSchema, Static } from "@sinclair/typebox";

import { SurfaceError } from "../SurfaceError.js";

/** An opaque page cursor: the keyset position of a page's last item, as base64url JSON. */
export function encodePageCursor(position: unknown): string {
    return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/** The position a cursor carries, or `400 invalid_request` when it is not one this route made. */
export function decodePageCursor<Schema extends TSchema>(
    schema: Schema,
    cursor: string | undefined,
): Static<Schema> | undefined {
    if (cursor === undefined) return undefined;
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (Value.Check(schema, value)) return value;
    } catch {
        // Falls through to the refusal below.
    }
    throw new SurfaceError("invalid_request", "The page cursor is not recognized.");
}
