import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// The provider library's refresh errors carry the HTTP status and a vetted OAuth code. Check the
// shape again here so free text or credential contents on any other error can never be logged.
const refreshFailureSchema = Type.Object(
    {
        status: Type.Integer({ minimum: 100, maximum: 599 }),
        code: Type.Optional(Type.String({ pattern: "^[a-z0-9_]{1,64}$" })),
        permanent: Type.Boolean(),
    },
    { additionalProperties: true },
);

/** The status, code, and next step a background refresh failure can safely log, if any. */
export function describeCredentialRefreshFailure(error: unknown): string {
    if (!Value.Check(refreshFailureSchema, error)) return ".";
    const reason = error.code === undefined ? "" : `, ${error.code}`;
    const next = error.permanent ? " Sign in to this account again." : "";
    return ` (HTTP ${error.status}${reason}).${next}`;
}
