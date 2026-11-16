import { readFile } from "node:fs/promises";

import type { RelayTokenDecision, RelayTokenRefusal } from "./AccountTokenVerifier.js";

/** The standalone daemon's own API: its Unix socket and the bearer token that means "owner". */
export interface LocalApi {
    readonly socketPath: string;
    readonly tokenPath: string;
}

export type HeaderPairs = readonly (readonly [string, string])[];

/** A request as the relay forwarded it, before the daemon has decided anything about it. */
export interface ForwardedRequestHead {
    readonly headers: HeaderPairs;
    readonly method: string;
    readonly path: string;
}

export type AuthorizeForwarded = (
    authorization: string | readonly string[] | undefined,
) => Promise<RelayTokenDecision>;

export interface RefusedForward {
    readonly code: string;
    readonly status: number;
}

export type ForwardAdmission =
    | {
          readonly admitted: true;
          /** When the caller's relay token expires; nothing it opened may outlive this. */
          readonly expiresAt: number;
          /** The caller's headers with its credential replaced by the local owner token. */
          readonly headers: Record<string, string | string[]>;
      }
    | { readonly admitted: false; readonly refusal: RefusedForward };

const REFUSALS: Readonly<Record<RelayTokenRefusal, RefusedForward>> = {
    forbidden: { code: "forbidden", status: 403 },
    unauthenticated: { code: "unauthorized", status: 401 },
    unverifiable: { code: "verification_unavailable", status: 503 },
};

/** Headers that describe one hop, or that would let the caller speak as someone else locally. */
const DROPPED_HEADERS = new Set([
    "authorization",
    "connection",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

/**
 * The security boundary of the relay path. A forwarded request is admitted to the local API only
 * after its own relay token verified as the owner's; only then is the caller's credential
 * replaced with the local owner token. A refused request never opens a local connection, and the
 * local token is not even read for it.
 */
export async function admitForwardedRequest(
    head: ForwardedRequestHead,
    authorize: AuthorizeForwarded,
    localApi: LocalApi,
): Promise<ForwardAdmission> {
    const presented = head.headers
        .filter(([name]) => name.toLowerCase() === "authorization")
        .map(([, value]) => value);
    // Two Authorization headers are ambiguous, so the verifier sees both and refuses.
    const decision = await authorize(presented.length === 1 ? presented[0] : presented);
    if (!decision.allowed) return { admitted: false, refusal: REFUSALS[decision.refusal] };
    if (!head.path.startsWith("/") || head.path.startsWith("//")) {
        return { admitted: false, refusal: { code: "bad_request", status: 400 } };
    }
    let localToken: string;
    try {
        localToken = (await readFile(localApi.tokenPath, "utf8")).trim();
    } catch {
        localToken = "";
    }
    if (localToken === "") {
        return { admitted: false, refusal: { code: "local_api_unavailable", status: 502 } };
    }
    const headers: Record<string, string | string[]> = {};
    for (const [rawName, value] of head.headers) {
        const name = rawName.toLowerCase();
        if (DROPPED_HEADERS.has(name)) continue;
        const existing = headers[name];
        if (existing === undefined) headers[name] = value;
        else if (typeof existing === "string") headers[name] = [existing, value];
        else existing.push(value);
    }
    headers.host = "localhost";
    headers.authorization = `Bearer ${localToken}`;
    return { admitted: true, expiresAt: decision.expiresAt, headers };
}
