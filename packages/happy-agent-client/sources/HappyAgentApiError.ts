import { Value } from "@sinclair/typebox/value";

import {
    authenticationMethodSchema,
    type AuthenticationChallenge,
} from "./protocol/authentication.js";

/**
 * A failed request, carrying what the daemon said about it.
 *
 * The daemon answers a failure with a human-readable `error` and a stable
 * machine-readable `code`. Clients branch on `code`; the set grows with the
 * product, and an unrecognized code is treated by its status class. The message
 * text is for display and logs and must never be matched on.
 */
export class HappyAgentApiError extends Error {
    /** The HTTP status the daemon answered with. */
    readonly status: number;
    /** The stable snake_case failure name, when the daemon named one. */
    readonly code: string | null;
    /**
     * The whole error body.
     *
     * Endpoints document extra fields alongside `error` and `code`: the
     * `If-Match` conflict carries `currentVersion` and the authoritative
     * resource, a lost event cursor carries the cursor to resume from, and a
     * file-write conflict carries the file's current `hash`.
     */
    readonly body: ApiErrorBody | null;
    /**
     * How to sign in, when a `401` says so.
     *
     * Only recognized methods are kept; `null` when the daemon offered none.
     */
    readonly authentication: AuthenticationChallenge | null;

    constructor(status: number, message: string, code: string | null, body: ApiErrorBody | null) {
        super(message);
        this.name = "HappyAgentApiError";
        this.status = status;
        this.code = code;
        this.body = body;
        this.authentication = status === 401 ? readChallenge(body) : null;
    }
}

function readChallenge(body: ApiErrorBody | null): AuthenticationChallenge | null {
    const authentication = body?.authentication;
    if (typeof authentication !== "object" || authentication === null) return null;
    const methods: unknown = (authentication as { methods?: unknown }).methods;
    if (!Array.isArray(methods)) return null;
    return {
        methods: methods.filter((method) => Value.Check(authenticationMethodSchema, method)),
    };
}

/** The JSON body of a failed request. */
export interface ApiErrorBody {
    /** A human-readable English message, for display and logs. */
    error?: string;
    /** A stable, machine-readable snake_case name for the failure. */
    code?: string;
    [field: string]: unknown;
}

/**
 * Reads a failed response into an error.
 *
 * A daemon that failed before it could write JSON — or a proxy in front of it
 * that answered instead — still produces a usable error, so the body is read
 * defensively rather than assumed.
 */
export async function readApiError(response: Response): Promise<HappyAgentApiError> {
    const body = await readErrorBody(response);
    const code = typeof body?.code === "string" ? body.code : null;
    const message =
        typeof body?.error === "string" && body.error.length > 0
            ? body.error
            : `The Happy agent answered ${String(response.status)}.`;
    return new HappyAgentApiError(response.status, message, code, body);
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | null> {
    try {
        const parsed: unknown = await response.json();
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return parsed as ApiErrorBody;
    } catch {
        return null;
    }
}
