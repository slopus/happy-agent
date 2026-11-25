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

/** What a refused renewal may safely say about itself: never vendor text or credential contents. */
export interface CredentialRefreshFailure {
    readonly status: number;
    readonly code: string | null;
    readonly permanent: boolean;
}

/** The status, vetted OAuth code, and permanence of a refused renewal, if the error carries them. */
export function readCredentialRefreshFailure(error: unknown): CredentialRefreshFailure | undefined {
    if (!Value.Check(refreshFailureSchema, error)) return undefined;
    return { status: error.status, code: error.code ?? null, permanent: error.permanent };
}

/** The status, code, and next step a background refresh failure can safely log, if any. */
export function describeCredentialRefreshFailure(error: unknown): string {
    const failure = readCredentialRefreshFailure(error);
    if (failure === undefined) return ".";
    const reason = failure.code === null ? "" : `, ${failure.code}`;
    const next = failure.permanent ? " Sign in to this account again." : "";
    return ` (HTTP ${failure.status}${reason}).${next}`;
}
