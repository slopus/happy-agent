/**
 * OAuth authorization code sign-in with PKCE for native apps (RFC 8252).
 *
 * These functions talk only to the authorization server a method names. The
 * daemon that advertised the method is not trusted with credentials: it never
 * sees the code, the verifier, or a refresh token, and a refresh token is only
 * ever sent to the refresh URL recorded when it was issued. The token and
 * refresh URLs must share the authorization URL's origin, so a code goes only
 * to the server that issued it, and an access token is returned only when its
 * `aud` names the server being signed in to, so a server that copied another
 * deployment's method never receives that deployment's token.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { HappyAgentOAuthError } from "./HappyAgentOAuthError.js";
import {
    oauthAuthenticationMethodSchema,
    oauthErrorResponseSchema,
    oauthTokenResponseSchema,
    type OAuthAuthenticationMethod,
} from "./protocol/authentication.js";

/**
 * A sign-in in progress. Keep it in memory until the redirect arrives. It is
 * frozen, with its own frozen copy of the method, so the endpoints checked at
 * the start are the ones used at the end.
 */
export interface OAuthSignIn {
    /** Open this in the system browser. */
    readonly url: string;
    /** The authorization server's host, to show the person where they are signing in. */
    readonly host: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeVerifier: string;
    readonly method: OAuthAuthenticationMethod;
    /** The server the token is for; its access token must name it in `aud`. */
    readonly serverUrl: string;
}

/** Tokens from a completed sign-in or refresh. Keeping them only in memory is supported. */
export interface OAuthCredential {
    /** The bearer token for the daemon. */
    readonly accessToken: string;
    /** When the access token expires, in epoch milliseconds, when the server said. */
    readonly expiresAt: number | null;
    /** The refresh token, or `null` when refresh is unavailable. */
    readonly refreshToken: string | null;
    /** The refresh URL recorded at sign-in; refresh tokens go nowhere else. */
    readonly refreshUrl: string | null;
    readonly clientId: string;
    /**
     * The RFC 8707 resource recorded at sign-in and sent again on refresh. Absent or `null`
     * when the method named none, including for credentials stored by older versions.
     */
    readonly resource?: string | null;
    /** The server recorded at sign-in; every refreshed token must name it in `aud` too. */
    readonly serverUrl: string;
}

export interface OAuthRequestOptions {
    /** The `fetch` for the authorization server. Defaults to the global one. */
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
}

/**
 * Start a sign-in: generate state and PKCE, and build the authorization URL.
 *
 * `serverUrl` is the server the person is signing in to, such as the URL from
 * a server link; the access token is accepted only when its `aud` names it.
 */
export async function beginOAuthSignIn(
    method: OAuthAuthenticationMethod,
    options: { readonly redirectUri: string; readonly serverUrl: string },
): Promise<OAuthSignIn> {
    if (!Value.Check(oauthAuthenticationMethodSchema, method)) {
        throw new HappyAgentOAuthError("invalid_response", "The sign-in method is not valid.");
    }
    method = Object.freeze({ ...method });
    const authorizationUrl = oneOriginAuthorizationUrl(method);
    secureUrl(options.serverUrl, { nameUnderLocalhost: true });
    if (method.resource !== undefined) resourceIndicator(method.resource);
    const redirect = new URL(options.redirectUri);
    if (redirect.hash !== "") {
        throw new HappyAgentOAuthError(
            "insecure_url",
            "The redirect URI must not have a fragment.",
        );
    }
    const state = randomBase64Url(16);
    const codeVerifier = randomBase64Url(32);
    const challenge = base64Url(
        new Uint8Array(
            await globalThis.crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(codeVerifier),
            ),
        ),
    );
    const parameters = {
        response_type: "code",
        client_id: method.clientId,
        redirect_uri: options.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(method.scope === undefined ? {} : { scope: method.scope }),
        ...(method.resource === undefined ? {} : { resource: method.resource }),
    };
    for (const [name, value] of Object.entries(parameters)) {
        authorizationUrl.searchParams.set(name, value);
    }
    return Object.freeze({
        codeVerifier,
        host: authorizationUrl.host,
        method,
        redirectUri: options.redirectUri,
        serverUrl: options.serverUrl,
        state,
        url: authorizationUrl.toString(),
    });
}

/** Finish a sign-in from the redirect it produced, exchanging the code at the method's token URL. */
export async function completeOAuthSignIn(
    signIn: OAuthSignIn,
    callbackUrl: string | URL,
    options: OAuthRequestOptions = {},
): Promise<OAuthCredential> {
    // A backstop for an attempt that was not built by `beginOAuthSignIn`: the
    // code still goes only to the origin the person was sent to sign in at.
    if (oneOriginAuthorizationUrl(signIn.method).origin !== new URL(signIn.url).origin) {
        throw differentSite();
    }
    const parameters = new URL(callbackUrl.toString()).searchParams;
    if (parameters.get("state") !== signIn.state) {
        throw new HappyAgentOAuthError(
            "state_mismatch",
            "The sign-in result does not match this sign-in attempt.",
        );
    }
    const error = parameters.get("error");
    if (error !== null) {
        throw new HappyAgentOAuthError(
            error,
            parameters.get("error_description") ?? "The sign-in was not completed.",
        );
    }
    const code = parameters.get("code");
    if (code === null || code.length === 0) {
        throw new HappyAgentOAuthError(
            "invalid_response",
            "The sign-in result does not contain an authorization code.",
        );
    }
    return await requestTokens(
        signIn.method.tokenUrl,
        {
            grant_type: "authorization_code",
            code,
            redirect_uri: signIn.redirectUri,
            client_id: signIn.method.clientId,
            code_verifier: signIn.codeVerifier,
            ...(signIn.method.resource === undefined ? {} : { resource: signIn.method.resource }),
        },
        {
            clientId: signIn.method.clientId,
            refreshToken: null,
            refreshUrl: signIn.method.refreshUrl ?? null,
            resource: signIn.method.resource ?? null,
            serverUrl: signIn.serverUrl,
        },
        options,
    );
}

/** Exchange the credential's refresh token at the refresh URL recorded when it was issued. */
export async function refreshOAuthCredential(
    credential: OAuthCredential,
    options: OAuthRequestOptions = {},
): Promise<OAuthCredential> {
    if (credential.refreshToken === null || credential.refreshUrl === null) {
        throw new HappyAgentOAuthError(
            "refresh_unavailable",
            "This sign-in cannot be refreshed. Sign in again.",
        );
    }
    return await requestTokens(
        credential.refreshUrl,
        {
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
            client_id: credential.clientId,
            ...(credential.resource == null ? {} : { resource: credential.resource }),
        },
        {
            clientId: credential.clientId,
            refreshToken: credential.refreshToken,
            refreshUrl: credential.refreshUrl,
            resource: credential.resource ?? null,
            serverUrl: credential.serverUrl,
        },
        options,
    );
}

async function requestTokens(
    url: string,
    form: Record<string, string>,
    previous: {
        readonly clientId: string;
        readonly refreshToken: string | null;
        readonly refreshUrl: string | null;
        readonly resource: string | null;
        readonly serverUrl: string;
    },
    options: OAuthRequestOptions,
): Promise<OAuthCredential> {
    const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
        response = await fetch(secureUrl(url), {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(form).toString(),
            redirect: "error",
            signal: options.signal ?? null,
        });
    } catch (error: unknown) {
        if (options.signal?.aborted === true) throw error;
        throw new HappyAgentOAuthError("network_error", "The sign-in server could not be reached.");
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }
    if (!response.ok) {
        if (Value.Check(oauthErrorResponseSchema, body)) {
            throw new HappyAgentOAuthError(
                body.error,
                body.error_description ?? "The sign-in server rejected the request.",
            );
        }
        throw new HappyAgentOAuthError(
            "invalid_response",
            `The sign-in server answered ${String(response.status)}.`,
        );
    }
    if (!Value.Check(oauthTokenResponseSchema, body)) {
        throw new HappyAgentOAuthError(
            "invalid_response",
            "The sign-in server returned an invalid token response.",
        );
    }
    if (!tokenNamesServer(body.access_token, previous.serverUrl)) {
        throw new HappyAgentOAuthError(
            "audience_mismatch",
            "This sign-in is for a different server.",
        );
    }
    return {
        accessToken: body.access_token,
        clientId: previous.clientId,
        expiresAt: body.expires_in === undefined ? null : Date.now() + body.expires_in * 1_000,
        refreshToken: body.refresh_token ?? previous.refreshToken,
        refreshUrl: previous.refreshUrl,
        ...(previous.resource === null ? {} : { resource: previous.resource }),
        serverUrl: previous.serverUrl,
    };
}

/**
 * Whether a JWT access token's `aud` names the server: an absolute URL with its
 * origin whose path, with a trailing `/` added when missing, equals the
 * server's. The token is not verified; only a genuine token is worth stealing,
 * and its genuine `aud` names the server it was issued for.
 */
function tokenNamesServer(token: string, serverUrl: string): boolean {
    let claims: unknown;
    try {
        const payload = token.split(".")[1] ?? "";
        const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        return false;
    }
    if (!Value.Check(accessTokenAudienceSchema, claims)) return false;
    const server = new URL(serverUrl);
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    return audiences.some((audience) => {
        let url: URL;
        try {
            url = new URL(audience);
        } catch {
            return false;
        }
        return (
            url.origin === server.origin && withSlash(url.pathname) === withSlash(server.pathname)
        );
    });
}

const accessTokenAudienceSchema = Type.Object({
    aud: Type.Union([Type.String(), Type.Array(Type.String())]),
});

function withSlash(path: string): string {
    return path.endsWith("/") ? path : `${path}/`;
}

/** The method's authorization URL, after checking its token and refresh URLs share its origin. */
function oneOriginAuthorizationUrl(method: OAuthAuthenticationMethod): URL {
    const authorizationUrl = secureUrl(method.authorizationUrl);
    for (const url of [method.tokenUrl, method.refreshUrl]) {
        if (url !== undefined && secureUrl(url).origin !== authorizationUrl.origin) {
            throw differentSite();
        }
    }
    return authorizationUrl;
}

function differentSite(): HappyAgentOAuthError {
    return new HappyAgentOAuthError(
        "insecure_url",
        "This server's sign-in settings would send your sign-in to a different site, so they can't be used.",
    );
}

/**
 * Credentials only travel over https, or plain http to this machine. A URL this
 * client fetches must name loopback itself, since `fetch` may send a name under
 * `localhost` to DNS. The server URL is never fetched here, only compared with
 * the token's `aud`, so a name under `localhost` (RFC 6761) counts for it.
 */
function secureUrl(value: string, options?: { readonly nameUnderLocalhost: boolean }): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new HappyAgentOAuthError("insecure_url", "A sign-in URL is not valid.");
    }
    const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(url.hostname) ||
        (options?.nameUnderLocalhost === true &&
            url.hostname.endsWith(".localhost") &&
            url.hostname.length > ".localhost".length);
    if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
    ) {
        throw new HappyAgentOAuthError(
            "insecure_url",
            "Sign-in URLs must use https, or http only on this machine.",
        );
    }
    return url;
}

/** An RFC 8707 resource indicator: an absolute URI without a fragment. */
function resourceIndicator(value: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new HappyAgentOAuthError("invalid_response", "The sign-in resource is not valid.");
    }
    if (url.hash !== "" || value.includes("#")) {
        throw new HappyAgentOAuthError(
            "invalid_response",
            "The sign-in resource must not have a fragment.",
        );
    }
}

function randomBase64Url(bytes: number): string {
    return base64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
