import { Type, type Static } from "@sinclair/typebox";

import { cloudVersionSchema } from "./CloudDatabase.js";

export const CLOUD_AUTHORIZATION_EXPIRY_FUNCTION = "cloud.expire-authorization";
export const CLOUD_AUTHORIZATION_EXPIRY_OPERATION = "cloud.authorization-expiry";
export const CLOUD_AUTHORIZATION_LOCK = "cloud.authorization";
export const CLOUD_PROFILE_SYNC_FUNCTION = "cloud.sync-profile";
export const CLOUD_PROFILE_SYNC_LOCK = "cloud.profile";
export const CLOUD_SOCIAL_SYNC_FUNCTION = "cloud.sync-social";
export const CLOUD_SOCIAL_SYNC_LOCK = "cloud.social";

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
