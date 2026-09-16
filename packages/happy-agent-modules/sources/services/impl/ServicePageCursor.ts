import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ServiceError } from "../Service.js";

const cursorSchema = Type.Object(
    {
        v: Type.Literal(1),
        workspaceId: cuid2Schema,
        includeStopped: Type.Boolean(),
        before: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
);
const encodedSchema = Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });

/** Pagination is an opaque position, never an authority or an event cursor. */
export function servicePageCursor(
    workspaceId: string,
    includeStopped: boolean,
    before: number | null,
): string | null {
    if (before === null) return null;
    const cursor = { v: 1, workspaceId, includeStopped, before };
    if (!Value.Check(cursorSchema, cursor)) throw invalidCursor();
    const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    if (!Value.Check(encodedSchema, encoded)) throw invalidCursor();
    return encoded;
}

export function readServicePageCursor(
    workspaceId: string,
    includeStopped: boolean,
    encoded: string | undefined,
): number | undefined {
    if (encoded === undefined) return undefined;
    if (!Value.Check(encodedSchema, encoded)) throw invalidCursor();
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw invalidCursor();
    let cursor: unknown;
    try {
        cursor = JSON.parse(decoded.toString("utf8"));
    } catch {
        throw invalidCursor();
    }
    if (
        !Value.Check(cursorSchema, cursor) ||
        cursor.workspaceId !== workspaceId ||
        cursor.includeStopped !== includeStopped
    )
        throw invalidCursor();
    return cursor.before;
}

function invalidCursor(): ServiceError {
    return new ServiceError(
        "invalid_request",
        "The service page cursor does not match this workspace and selection.",
    );
}
