import { timingSafeEqual } from "node:crypto";

/** The most text a pasted address may hold. */
const MAX_PASTED_LENGTH = 16_384;

export type McpLoginRedirect =
    | { readonly ok: true; readonly code: string }
    | { readonly ok: false; readonly reason: string };

/**
 * Read the address a person's browser landed on after signing in, as they pasted it. It must be
 * the login's own redirect address, carry this login's state, and carry a code; an authorization
 * server that names its issuer must name the expected one. Reasons are written for the person.
 */
export function parseMcpLoginRedirect(
    pasted: string,
    expected: { readonly redirectUri: string; readonly state: string; readonly issuer?: string },
): McpLoginRedirect {
    let text = pasted.trim();
    if (text.length === 0) return { ok: false, reason: "Nothing was pasted." };
    if (text.length > MAX_PASTED_LENGTH)
        return { ok: false, reason: "The pasted text is too long." };
    // Chat clients and terminals often wrap a link in angle brackets or quotes.
    text = text.replace(/^[<"'`]+/u, "").replace(/[>"'`]+$/u, "");
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) text = `http://${text}`;
    let landed: URL;
    try {
        landed = new URL(text);
    } catch {
        return { ok: false, reason: "That is not a web address." };
    }
    const redirect = new URL(expected.redirectUri);
    if (landed.origin !== redirect.origin || landed.pathname !== redirect.pathname) {
        return {
            ok: false,
            reason: `That is not the address the sign-in sends you back to, which starts with ${redirect.origin}${redirect.pathname}.`,
        };
    }
    const error = landed.searchParams.get("error");
    if (error !== null) {
        return {
            ok: false,
            reason:
                error === "access_denied"
                    ? "The sign-in was declined."
                    : "The authorization server did not complete the sign-in.",
        };
    }
    const state = landed.searchParams.get("state");
    if (state === null || !sameSecret(state, expected.state)) {
        return {
            ok: false,
            reason: "That address belongs to a different sign-in attempt. Ask to log in again for a fresh link.",
        };
    }
    const issuer = landed.searchParams.get("iss");
    if (issuer !== null && expected.issuer !== undefined && issuer !== expected.issuer) {
        return { ok: false, reason: "That address came from a different authorization server." };
    }
    const code = landed.searchParams.get("code");
    if (code === null || code.length === 0) {
        return { ok: false, reason: "That address has no sign-in code in it." };
    }
    return { ok: true, code };
}

function sameSecret(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
