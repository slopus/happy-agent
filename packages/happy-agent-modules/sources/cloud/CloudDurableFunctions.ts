import { Type, type Static } from "@sinclair/typebox";
import { cloudEnvironmentSchema } from "@slopus/happy-agent-client";

import { cloudVersionSchema } from "./CloudDatabase.js";

export const CLOUD_AUTHORIZATION_EXPIRY_FUNCTION = "cloud.expire-authorization";
export const CLOUD_AUTHORIZATION_EXPIRY_OPERATION = "cloud.authorization-expiry";
export const CLOUD_DISCONNECT_FUNCTION = "cloud.disconnect";
export const CLOUD_ENROLLMENT_FUNCTION = "cloud.reconcile-enrollment";
export const CLOUD_KEYS_FUNCTION = "cloud.reconcile-keys";
export const CLOUD_KEYS_MUTATION_FUNCTION = "cloud.mutate-keys";
export const CLOUD_PROFILE_SYNC_FUNCTION = "cloud.sync-profile";
export const CLOUD_SOCIAL_SYNC_FUNCTION = "cloud.sync-social";

export const cloudAuthorizationExpiryArgumentsSchema = Type.Object(
    {
        expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        version: cloudVersionSchema,
    },
    { additionalProperties: false },
);

export const cloudAuthorizationExpiryResultSchema = Type.Null();

export type CloudAuthorizationExpiryArguments = Static<
    typeof cloudAuthorizationExpiryArgumentsSchema
>;

export const cloudDisconnectArgumentsSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        generation: Type.String({ minLength: 1, maxLength: 128 }),
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export const cloudDisconnectResultSchema = Type.Null();

export type CloudDisconnectArguments = Static<typeof cloudDisconnectArgumentsSchema>;

export const cloudAccountArgumentsSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export const cloudAccountResultSchema = Type.Null();

export type CloudAccountArguments = Static<typeof cloudAccountArgumentsSchema>;

export const cloudKeysMutationArgumentsSchema = Type.Object(
    {
        environment: cloudEnvironmentSchema,
        generation: Type.String({ minLength: 1, maxLength: 128 }),
        kind: Type.Union([Type.Literal("create"), Type.Literal("reset"), Type.Literal("restore")]),
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export const cloudKeysMutationResultSchema = Type.Null();

export type CloudKeysMutationArguments = Static<typeof cloudKeysMutationArgumentsSchema>;

export const cloudProfileSyncArgumentsSchema = Type.Object(
    {
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export const cloudProfileSyncResultSchema = Type.Null();

export type CloudProfileSyncArguments = Static<typeof cloudProfileSyncArgumentsSchema>;

export const cloudSocialSyncArgumentsSchema = Type.Object(
    {
        remoteVersion: cloudVersionSchema,
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export const cloudSocialSyncResultSchema = Type.Null();

export type CloudSocialSyncArguments = Static<typeof cloudSocialSyncArgumentsSchema>;
