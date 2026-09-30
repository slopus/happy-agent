/**
 * OAuth authorization code sign-in with PKCE for native apps (RFC 8252).
 *
 * These functions talk only to the authorization server a method names. The
 * daemon that advertised the method is not trusted with credentials: it never
 * sees the code, the verifier, or a refresh token, and a refresh token is only
 * ever sent to the refresh URL recorded when it was issued.
 */

import { Value } from "@sinclair/typebox/value";

import { HappyAgentOAuthError } from "./HappyAgentOAuthError.js";
import {
    oauthAuthenticationMethodSchema,
    oauthErrorResponseSchema,
    oauthTokenResponseSchema,
    type OAuthAuthenticationMethod,
} from "./protocol/authentication.js";

/** A sign-in in progress. Keep it in memory until the redirect arrives. */
export interface OAuthSignIn {
    /** Open this in the system browser. */
    readonly url: string;
    /** The authorization server's host, to show the person where they are signing in. */
    readonly host: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeVerifier: string;
    readonly method: OAuthAuthenticationMethod;
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
}

export interface OAuthRequestOptions {
    /** The `fetch` for the authorization server. Defaults to the global one. */
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
}

/** Start a sign-in: generate state and PKCE, and build the authorization URL. */
export async function beginOAuthSignIn(
    method: OAuthAuthenticationMethod,
    options: { readonly redirectUri: string },
): Promise<OAuthSignIn> {
    if (!Value.Check(oauthAuthenticationMethodSchema, method)) {
        throw new HappyAgentOAuthError("invalid_response", "The sign-in method is not valid.");
    }
    const authorizationUrl = secureUrl(method.authorizationUrl);
    secureUrl(method.tokenUrl);
    if (method.refreshUrl !== undefined) secureUrl(method.refreshUrl);
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
    };
    for (const [name, value] of Object.entries(parameters)) {
        authorizationUrl.searchParams.set(name, value);
    }
    return {
        codeVerifier,
        host: authorizationUrl.host,
        method,
        redirectUri: options.redirectUri,
        state,
        url: authorizationUrl.toString(),
    };
}

/** Finish a sign-in from the redirect it produced, exchanging the code at the method's token URL. */
export async function completeOAuthSignIn(
    signIn: OAuthSignIn,
    callbackUrl: string | URL,
    options: OAuthRequestOptions = {},
): Promise<OAuthCredential> {
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
        },
        {
            clientId: signIn.method.clientId,
            refreshToken: null,
            refreshUrl: signIn.method.refreshUrl ?? null,
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
        },
        {
            clientId: credential.clientId,
            refreshToken: credential.refreshToken,
            refreshUrl: credential.refreshUrl,
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
    return {
        accessToken: body.access_token,
        clientId: previous.clientId,
        expiresAt: body.expires_in === undefined ? null : Date.now() + body.expires_in * 1_000,
        refreshToken: body.refresh_token ?? previous.refreshToken,
        refreshUrl: previous.refreshUrl,
    };
}

/** Credentials only travel over https, or plain http to this machine. */
function secureUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new HappyAgentOAuthError("insecure_url", "A sign-in URL is not valid.");
    }
    const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
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

function randomBase64Url(bytes: number): string {
    return base64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
