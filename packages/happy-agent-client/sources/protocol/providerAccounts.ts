import { type Static, Type } from "@sinclair/typebox";

import { daemonConfigSchema, providerVerificationResponseSchema } from "./daemon.js";

const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });
/** The daemon trims a credential and rejects one with whitespace or control characters inside. */
const credentialSchema = Type.String({ minLength: 1, maxLength: 8_192 });

/** Account types `POST /v0/providers` adds without a credential; see Provider accounts. */
export const providerAccountSignInTypeSchema = Type.Union([
    Type.Literal("codex"),
    Type.Literal("claude"),
    Type.Literal("grok"),
    Type.Literal("antigravity"),
]);
export type ProviderAccountSignInType = Static<typeof providerAccountSignInTypeSchema>;

/** Account types that accept a pasted `apiKey`. */
export const providerAccountApiKeyTypeSchema = Type.Union([
    Type.Literal("codex"),
    Type.Literal("claude"),
    Type.Literal("grok"),
]);
export type ProviderAccountApiKeyType = Static<typeof providerAccountApiKeyTypeSchema>;

const regionSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" });

/** A Bedrock account's region and either an access key pair or a Bedrock API key. */
export const providerAccountBedrockSchema = Type.Union([
    Type.Object(
        {
            region: regionSchema,
            accessKeyId: credentialSchema,
            secretAccessKey: credentialSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { region: regionSchema, bearerToken: credentialSchema },
        { additionalProperties: false },
    ),
]);
export type ProviderAccountBedrock = Static<typeof providerAccountBedrockSchema>;

/**
 * `POST /v0/providers` request. Without a credential the account signs in on its own afterwards
 * through Provider sign-in; with one, the daemon verifies it before saving anything.
 */
export const providerAccountCreateRequestSchema = Type.Union([
    Type.Object(
        {
            type: providerAccountSignInTypeSchema,
            mutationId: Type.Optional(mutationIdSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: providerAccountApiKeyTypeSchema,
            apiKey: credentialSchema,
            mutationId: Type.Optional(mutationIdSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("bedrock"),
            bedrock: providerAccountBedrockSchema,
            mutationId: Type.Optional(mutationIdSchema),
        },
        { additionalProperties: false },
    ),
]);
export type ProviderAccountCreateRequest = Static<typeof providerAccountCreateRequestSchema>;

/** `POST /v0/providers` `201` response. */
export const providerAccountCreateResponseSchema = Type.Object({
    /** The new account's ID, such as `codex_2`. */
    providerId: Type.String({ minLength: 1 }),
    /** The effective configuration after the account was added. */
    config: daemonConfigSchema,
    /** The check of the submitted credential; present only when one was submitted. */
    verification: Type.Optional(providerVerificationResponseSchema),
});
export type ProviderAccountCreateResponse = Static<typeof providerAccountCreateResponseSchema>;

/** `DELETE /v0/providers/:providerId` request; an empty body is equivalent to `{}`. */
export const providerAccountDeleteRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderAccountDeleteRequest = Static<typeof providerAccountDeleteRequestSchema>;

/** `DELETE /v0/providers/:providerId` response. */
export const providerAccountDeleteResponseSchema = Type.Object({
    /** The effective configuration after the account was removed. */
    config: daemonConfigSchema,
});
export type ProviderAccountDeleteResponse = Static<typeof providerAccountDeleteResponseSchema>;
