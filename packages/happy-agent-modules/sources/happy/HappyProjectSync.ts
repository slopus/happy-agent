import { Type, type Static } from "@sinclair/typebox";
import type { HappyEncryptionVariant } from "./HappyCredentials.js";

const fingerprintSchema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });

export const happyProjectMetadataSchema = Type.Object(
    {
        kind: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("regular")])),
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);

export type HappyProjectMetadata = Static<typeof happyProjectMetadataSchema>;

export const happyProjectAvatarPreviewSchema = Type.Object(
    {
        mimeType: Type.Literal("image/webp"),
        thumbhash: Type.String({ minLength: 4, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type HappyProjectAvatarPreview = Static<typeof happyProjectAvatarPreviewSchema>;

export const happyProjectSyncStateSchema = Type.Object(
    {
        avatarFingerprint: Type.Optional(fingerprintSchema),
        avatarVersion: Type.Optional(Type.Integer({ minimum: 1 })),
        credentialFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
        createdAt: Type.Integer({ minimum: 0 }),
        encryptionKeyBase64: Type.String({ minLength: 1 }),
        encryptionVariant: Type.Union([Type.Literal("legacy"), Type.Literal("dataKey")]),
        localProjectId: Type.String({ minLength: 1, maxLength: 96 }),
        metadataFingerprint: Type.Optional(fingerprintSchema),
        remoteProjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type HappyProjectSyncState = Static<typeof happyProjectSyncStateSchema>;

export interface HappyProjectSyncInput {
    readonly credentialFingerprint: string;
    readonly encryptionKeyBase64: string;
    readonly encryptionVariant: HappyEncryptionVariant;
    readonly localProjectId: string;
}
