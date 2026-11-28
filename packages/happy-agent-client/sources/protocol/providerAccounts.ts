import { type Static, Type } from "@sinclair/typebox";

import { daemonConfigSchema, providerVerificationResponseSchema } from "./daemon.js";

const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });
/**
 * A credential as the daemon reads it: at most 65,536 characters as sent, trimmed of surrounding
 * whitespace, and then 1–8,192 characters with no whitespace and no C0, DEL, or C1 control
 * character inside.
 */
const credentialSchema = Type.String({
    maxLength: 65_536,
    pattern: "^\\s*[^\\s\\x00-\\x1f\\x7f-\\x9f]{1,8192}\\s*$",
});

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
