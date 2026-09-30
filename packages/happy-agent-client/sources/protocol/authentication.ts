/** Authentication discovery: whether a request is signed in, and how a person signs in. */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable } from "./common.js";

/**
 * A sign-in completed in the system browser.
 *
 * The page signs the person in and redirects to the client's `redirectUri` with
 * `#token=<jwt>&state=<state>` in the fragment.
 */
export const browserAuthenticationMethodSchema = Type.Object({
    type: Type.Literal("browser"),
    /** Stable method identity, such as `"jwt"`. */
    id: Type.String({ minLength: 1 }),
    /** Human-readable method name for display. */
    name: Type.String({ minLength: 1, maxLength: 64 }),
    /** The page to open in the system browser. */
    url: Type.String({ minLength: 1 }),
});
export type BrowserAuthenticationMethod = Static<typeof browserAuthenticationMethodSchema>;

/**
 * One way to sign in, discriminated by `type`.
 *
 * The set grows with the product; clients ignore methods whose `type` they do
 * not recognize.
 */
export const authenticationMethodSchema = Type.Union([browserAuthenticationMethodSchema]);
export type AuthenticationMethod = Static<typeof authenticationMethodSchema>;

/** Query for `GET /v0/authentication`. */
export const authenticationQuerySchema = Type.Object({
    /** Absolute URL without a fragment where the client receives the sign-in result. */
    redirectUri: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    /** Client-generated value returned unchanged with the result; requires `redirectUri`. */
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type AuthenticationQuery = Static<typeof authenticationQuerySchema>;

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
