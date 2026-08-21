import { Type, type Static } from "@sinclair/typebox";

import { p2pPeerIdentitySchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;
const providerIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const modelIdsSchema = Type.Array(Type.String({ maxLength: 256, minLength: 1 }), {
    maxItems: 1_024,
});
export const P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
const base64UrlSchema = Type.String({
    maxLength: 7 * 1024 * 1024,
    minLength: 1,
    pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
});
const credentialStringSchema = Type.String({ maxLength: 2 * 1024 * 1024, minLength: 1 });
const bedrockModelOverridesSchema = Type.Record(
    Type.String({ maxLength: 256, minLength: 1 }),
    Type.Object(
        {
            endpoint: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
            region: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
            transport: Type.Optional(Type.Union([Type.Literal("mantle"), Type.Literal("runtime")])),
        },
        exact,
    ),
);

export const p2pCredentialVisibilitySchema = Type.Union([
    Type.Literal("owner_only"),
    Type.Literal("shared"),
]);
export type P2pCredentialVisibility = Static<typeof p2pCredentialVisibilitySchema>;

export const p2pShareSchema = Type.Union([Type.Literal("disabled"), p2pCredentialVisibilitySchema]);
export type P2pShare = Static<typeof p2pShareSchema>;

const provisionedProviderConfigBase = {
    enabled: Type.Boolean(),
    excludeModels: Type.Optional(modelIdsSchema),
    includeModels: Type.Optional(modelIdsSchema),
};

/**
 * The configuration a receiving Happy Terminal needs to build a provider after the optional credential
 * material has been applied. It deliberately excludes local secret paths such as auth files and
 * native configuration directories.
 */
export const provisionedProviderConfigSchema = Type.Union([
    Type.Object(
        {
            ...provisionedProviderConfigBase,
            baseUrl: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
            transport: Type.Optional(
                Type.Union([
                    Type.Literal("auto"),
                    Type.Literal("sse"),
                    Type.Literal("websocket"),
                    Type.Literal("websocket-cached"),
                ]),
            ),
            type: Type.Literal("codex"),
        },
        exact,
    ),
    Type.Object({ ...provisionedProviderConfigBase, type: Type.Literal("claude") }, exact),
    Type.Object(
        {
            ...provisionedProviderConfigBase,
            baseUrl: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
            type: Type.Literal("grok"),
        },
        exact,
    ),
    Type.Object(
        {
            ...provisionedProviderConfigBase,
            modelOverrides: Type.Optional(bedrockModelOverridesSchema),
            region: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
            searchModelId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
            type: Type.Literal("bedrock"),
        },
        exact,
    ),
]);
export type ProvisionedProviderConfig = Static<typeof provisionedProviderConfigSchema>;

/**
 * Material is carried separately from config so it can only exist inside a P2P encrypted
 * envelope. The type tag permits the receiver to reject credentials applied to another vendor.
 */
export const p2pCredentialMaterialSchema = Type.Union([
    Type.Object({ apiKey: credentialStringSchema, type: Type.Literal("codex") }, exact),
    Type.Object(
        {
            accessToken: credentialStringSchema,
            accountId: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
            type: Type.Literal("codex"),
        },
        exact,
    ),
    Type.Object({ apiKey: credentialStringSchema, type: Type.Literal("claude") }, exact),
    Type.Object({ authToken: credentialStringSchema, type: Type.Literal("claude") }, exact),
    Type.Object({ oauthToken: credentialStringSchema, type: Type.Literal("claude") }, exact),
    Type.Object({ apiKey: credentialStringSchema, type: Type.Literal("grok") }, exact),
    Type.Object(
        {
            accessToken: credentialStringSchema,
            createdAt: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
            expiresAt: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
            type: Type.Literal("grok"),
        },
        exact,
    ),
    Type.Object({ bearerToken: credentialStringSchema, type: Type.Literal("bedrock") }, exact),
]);
export type P2pCredentialMaterial = Static<typeof p2pCredentialMaterialSchema>;

export const provisionedProviderSchema = Type.Union([
    Type.Object(
        {
            config: Type.Object(
                {
                    ...provisionedProviderConfigBase,
                    baseUrl: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
                    transport: Type.Optional(
                        Type.Union([
                            Type.Literal("auto"),
                            Type.Literal("sse"),
                            Type.Literal("websocket"),
                            Type.Literal("websocket-cached"),
                        ]),
                    ),
                    type: Type.Literal("codex"),
                },
                exact,
            ),
            material: Type.Optional(
                Type.Union([
                    Type.Object(
                        { apiKey: credentialStringSchema, type: Type.Literal("codex") },
                        exact,
                    ),
                    Type.Object(
                        {
                            accessToken: credentialStringSchema,
                            accountId: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
                            type: Type.Literal("codex"),
                        },
                        exact,
                    ),
                ]),
            ),
            providerId: providerIdSchema,
            visibility: p2pCredentialVisibilitySchema,
        },
        exact,
    ),
    Type.Object(
        {
            config: Type.Object(
                { ...provisionedProviderConfigBase, type: Type.Literal("claude") },
                exact,
            ),
            material: Type.Optional(
                Type.Union([
                    Type.Object(
                        { apiKey: credentialStringSchema, type: Type.Literal("claude") },
                        exact,
                    ),
                    Type.Object(
                        {
                            authToken: credentialStringSchema,
                            type: Type.Literal("claude"),
                        },
                        exact,
                    ),
                    Type.Object(
                        {
                            oauthToken: credentialStringSchema,
                            type: Type.Literal("claude"),
                        },
                        exact,
                    ),
                ]),
            ),
            providerId: providerIdSchema,
            visibility: p2pCredentialVisibilitySchema,
        },
        exact,
    ),
    Type.Object(
        {
            config: Type.Object(
                {
                    ...provisionedProviderConfigBase,
                    baseUrl: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
                    type: Type.Literal("grok"),
                },
                exact,
            ),
            material: Type.Optional(
                Type.Union([
                    Type.Object(
                        { apiKey: credentialStringSchema, type: Type.Literal("grok") },
                        exact,
                    ),
                    Type.Object(
                        {
                            accessToken: credentialStringSchema,
                            createdAt: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
                            expiresAt: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
                            type: Type.Literal("grok"),
                        },
                        exact,
                    ),
                ]),
            ),
            providerId: providerIdSchema,
            visibility: p2pCredentialVisibilitySchema,
        },
        exact,
    ),
    Type.Object(
        {
            config: Type.Object(
                {
                    ...provisionedProviderConfigBase,
                    modelOverrides: Type.Optional(bedrockModelOverridesSchema),
                    region: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
                    searchModelId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
                    type: Type.Literal("bedrock"),
                },
                exact,
            ),
            material: Type.Optional(
                Type.Object(
                    { bearerToken: credentialStringSchema, type: Type.Literal("bedrock") },
                    exact,
                ),
            ),
            providerId: providerIdSchema,
            visibility: p2pCredentialVisibilitySchema,
        },
        exact,
    ),
]);
export type ProvisionedProvider = Static<typeof provisionedProviderSchema>;

/**
 * One authoritative owner's ordered provider snapshot. Each peer stores separate snapshots by
 * owner, so two owners may provision the same provider ID without overwriting one another.
 */
export const p2pCredentialSnapshotSchema = Type.Object(
    {
        owner: p2pPeerIdentitySchema,
        providers: Type.Array(provisionedProviderSchema, { maxItems: 128 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type P2pCredentialSnapshot = Static<typeof p2pCredentialSnapshotSchema>;

/**
 * A credential snapshot encrypted by the sender's P2P identity for the receiving Happy Terminal.
 */
export const p2pEncryptedCredentialSnapshotSchema = Type.Object(
    {
        algorithm: Type.Literal("nacl_box"),
        ciphertext: base64UrlSchema,
        nonce: Type.String({
            maxLength: 32,
            minLength: 32,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        owner: p2pPeerIdentitySchema,
    },
    exact,
);
export type P2pEncryptedCredentialSnapshot = Static<typeof p2pEncryptedCredentialSnapshotSchema>;

/** The receiver's authoritative state after accepting an owner credential snapshot. */
export const p2pCredentialReplaceResponseSchema = Type.Object(
    {
        changed: Type.Boolean(),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type P2pCredentialReplaceResponse = Static<typeof p2pCredentialReplaceResponseSchema>;

/**
 * An authenticated receiver's version hint for an owner whose durable local version was reset.
 * The owner must retry above this version; the receiver never accepts the stale snapshot itself.
 */
export const p2pCredentialVersionConflictResponseSchema = Type.Object(
    {
        error: Type.String({ minLength: 1 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type P2pCredentialVersionConflictResponse = Static<
    typeof p2pCredentialVersionConflictResponseSchema
>;
