import { authenticationQuerySchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import type { TeamAuthenticationRedirect } from "../team/index.js";
import { invalidRequest } from "./ApiError.js";

/** Read the optional browser sign-in redirect from `GET /v0/authentication`'s query. */
export function parseAuthenticationRedirect(
    searchParams: URLSearchParams,
): TeamAuthenticationRedirect | undefined {
    const redirectUris = searchParams.getAll("redirectUri");
    const states = searchParams.getAll("state");
    if (redirectUris.length > 1 || states.length > 1) {
        throw invalidRequest("Provide at most one redirectUri and one state.");
    }
    const query = {
        ...(redirectUris[0] === undefined ? {} : { redirectUri: redirectUris[0] }),
        ...(states[0] === undefined ? {} : { state: states[0] }),
    };
    if (!Value.Check(authenticationQuerySchema, query)) {
        throw invalidRequest("The sign-in redirect or state is invalid.");
    }
    if (query.redirectUri === undefined) {
        if (query.state !== undefined) throw invalidRequest("A state requires a redirectUri.");
        return undefined;
    }
    if (query.redirectUri.includes("#") || !URL.canParse(query.redirectUri)) {
        throw invalidRequest("The redirectUri must be an absolute URL without a fragment.");
    }
    return query.state === undefined
        ? { redirectUri: query.redirectUri }
        : { redirectUri: query.redirectUri, state: query.state };
}
