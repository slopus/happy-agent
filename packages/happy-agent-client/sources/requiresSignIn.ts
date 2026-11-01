/**
 * Telling the daemon's own errors from answers by something in front of it.
 *
 * Every error the daemon writes is JSON with a string `error` and `code`. A load balancer or an
 * identity-aware proxy that refuses a request answers with something else, often a redirect to a
 * sign-in page. API.md, under "Credentials on the wire and signing in again", defines which
 * answers mean the person must sign in again.
 */

/** Whether a response is a Happy error: JSON whose body has a string `error` and `code`. */
export function isHappyErrorBody(contentType: string | null | undefined, body: unknown): boolean {
    if (contentType == null) return false;
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") return false;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
    const fields = body as { readonly error?: unknown; readonly code?: unknown };
    return typeof fields.error === "string" && typeof fields.code === "string";
}

/**
 * Whether an answer with this status means signing in again: any redirect (a `3xx` other than
 * `304 Not Modified`), any `401`, or a `403`
 * that is not a Happy error. `opaqueRedirect` is a redirect a browser's `fetch` hides behind
 * status `0`.
 *
 * A `401` that is a Happy error may be the team profile gate rather than an expired sign-in; check
 * `GET /v0/authentication` with the same token before sending the person to sign in.
 */
export function statusRequiresSignIn(
    status: number,
    happyError: boolean,
    opaqueRedirect = false,
): boolean {
    if (opaqueRedirect || isRedirectStatus(status)) return true;
    if (status === 401) return true;
    return status === 403 && !happyError;
}

/**
 * Whether a response means signing in again. Pass the parsed body when it has been read; a
 * response without one is judged by its status alone, as an answer that is not a Happy error.
 */
export function responseRequiresSignIn(response: Response, body?: unknown): boolean {
    return statusRequiresSignIn(
        response.status,
        isHappyErrorBody(response.headers.get("content-type"), body),
        response.type === "opaqueredirect",
    );
}

/** A `3xx` that sends the request elsewhere; `304 Not Modified` answers a conditional request. */
export function isRedirectStatus(status: number): boolean {
    return status >= 300 && status < 400 && status !== 304;
}
