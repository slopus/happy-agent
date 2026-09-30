/** Authentication discovery: whether a request is signed in, and how a person signs in. */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable } from "./common.js";

const urlSchema = Type.String({ minLength: 1, maxLength: 2048 });

/**
 * A sign-in completed with the OAuth authorization code flow and PKCE.
 *
 * The client talks to these endpoints directly. The daemon never receives the
 * authorization code, the PKCE verifier, or a refresh token.
 */
export const oauthAuthenticationMethodSchema = Type.Object({
    type: Type.Literal("oauth"),
    /** Stable method identity, such as `"jwt"`. */
    id: Type.String({ minLength: 1 }),
    /** Human-readable method name for display. */
    name: Type.String({ minLength: 1, maxLength: 64 }),
    /** The authorization endpoint, opened in the system browser. */
    authorizationUrl: urlSchema,
    /** Where the authorization code is exchanged for tokens. */
    tokenUrl: urlSchema,
    /** Where a refresh token is exchanged; absent when refresh is unavailable. */
    refreshUrl: Type.Optional(urlSchema),
    /** The public OAuth client identifier. */
    clientId: Type.String({ minLength: 1, maxLength: 256 }),
    /** The space-separated scope requested during authorization. */
    scope: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
export type OAuthAuthenticationMethod = Static<typeof oauthAuthenticationMethodSchema>;

/**
 * One way to sign in, discriminated by `type`.
 *
 * The set grows with the product; clients ignore methods whose `type` they do
 * not recognize.
 */
export const authenticationMethodSchema = Type.Union([oauthAuthenticationMethodSchema]);
export type AuthenticationMethod = Static<typeof authenticationMethodSchema>;

/** `GET /v0/authentication` */
export const authenticationResponseSchema = Type.Object({
    /** `true` only when the request carried a valid bearer token. */
    authenticated: Type.Boolean(),
    /** The onboarded team member's installation-local Happy user ID; otherwise `null`. */
    userId: Nullable(Type.String()),
    /** Available sign-in methods in display order. */
    methods: Type.Array(authenticationMethodSchema),
});
export type AuthenticationResponse = Static<typeof authenticationResponseSchema>;

/** The additive `authentication` field of a `401` body. */
export const authenticationChallengeSchema = Type.Object({
    methods: Type.Array(authenticationMethodSchema),
});
export type AuthenticationChallenge = Static<typeof authenticationChallengeSchema>;

/** A successful OAuth token endpoint response (RFC 6749 section 5.1). */
export const oauthTokenResponseSchema = Type.Object({
    access_token: Type.String({ minLength: 1, maxLength: 16_384 }),
    token_type: Type.String({ pattern: "^[Bb][Ee][Aa][Rr][Ee][Rr]$" }),
    expires_in: Type.Optional(Type.Number({ minimum: 0 })),
    refresh_token: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
});
export type OAuthTokenResponse = Static<typeof oauthTokenResponseSchema>;

/** An OAuth error response (RFC 6749 section 5.2) or authorization error redirect. */
export const oauthErrorResponseSchema = Type.Object({
    error: Type.String({ minLength: 1, maxLength: 256 }),
    error_description: Type.Optional(Type.String({ maxLength: 2048 })),
});
export type OAuthErrorResponse = Static<typeof oauthErrorResponseSchema>;
