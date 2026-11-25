import { type Static, Type } from "@sinclair/typebox";

import { providerCliOperationSchema } from "./providerClis.js";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });

/**
 * Where an account's credential comes from and how it can sign in; see "The account's credential
 * in `GET /v0/config`" under Provider sign-in in API.md. Present only on `codex`, `claude`, and
 * `grok` accounts, and only from daemons that report `capabilities.providerSignIn`.
 */
export const providerCredentialSchema = Type.Object({
    /**
     * `internal` (owned by this installation), `system` (the machine's own sign-in or
     * environment), `configured` (named in configuration), or newer; treat unknown values as
     * `configured`.
     */
    source: Type.String({ minLength: 1 }),
    /** `device`, `browser`, or newer, in the order the daemon prefers them. */
    methods: Type.Array(Type.String()),
    /** Whether `PUT /v0/providers/:providerId/token` accepts a pasted token for the account. */
    acceptsToken: Type.Boolean(),
});
export type ProviderCredential = Static<typeof providerCredentialSchema>;

/** One account's sign-in into a credential this installation owns; see Provider sign-in. */
export const providerSignInSchema = Type.Object({
    providerId: Type.String({ minLength: 1 }),
    /** The assistant whose program signs the account in: `codex`, `claude`, `grok`, or newer. */
    cliId: Type.String({ minLength: 1 }),
    /** Whether that program is installed on the daemon's machine; signing in needs it. */
    installed: Type.Boolean(),
    credential: providerCredentialSchema,
    /** The installation's own sign-in, when the source is `internal` and the vendor reveals it. */
    account: Type.Union([
        Type.Object({ email: nullableString, plan: nullableString }),
        Type.Null(),
    ]),
    /** The current or most recent sign-in, always of kind `sign_in`. */
    operation: Type.Union([providerCliOperationSchema, Type.Null()]),
    /** UUIDv7; keep the object with the greater one. */
    version: Type.String({ minLength: 1 }),
    updatedAt: Type.Integer({ minimum: 0 }),
});
export type ProviderSignIn = Static<typeof providerSignInSchema>;

/** Every `/v0/providers/:providerId/sign-in` route and the token route answer with this. */
export const providerSignInResponseSchema = Type.Object({ providerSignIn: providerSignInSchema });
export type ProviderSignInResponse = Static<typeof providerSignInResponseSchema>;

/** `POST /v0/providers/:providerId/sign-in` request. */
export const providerSignInStartRequestSchema = Type.Object({
    /** One of the account's `credential.methods`; omitted, the daemon uses the first. */
    method: Type.Optional(Type.String({ minLength: 1 })),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderSignInStartRequest = Static<typeof providerSignInStartRequestSchema>;

/** `POST /v0/providers/:providerId/sign-in/code` request. */
export const providerSignInCodeRequestSchema = Type.Object({
    code: Type.String({ minLength: 1, maxLength: 2_048 }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderSignInCodeRequest = Static<typeof providerSignInCodeRequestSchema>;

/** `POST /v0/providers/:providerId/sign-in/cancel` request. */
export const providerSignInCancelRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderSignInCancelRequest = Static<typeof providerSignInCancelRequestSchema>;

/** `PUT /v0/providers/:providerId/token` request, for Claude accounts. */
export const providerTokenRequestSchema = Type.Object({
    /** The daemon removes all whitespace before validating the token's shape and saving it. */
    token: Type.String(),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderTokenRequest = Static<typeof providerTokenRequestSchema>;

/** `provider_sign_in.updated`: one account's complete provider sign-in object. */
export interface ProviderSignInUpdatedPayload {
    providerSignIn: ProviderSignIn;
    mutationId?: string;
}
