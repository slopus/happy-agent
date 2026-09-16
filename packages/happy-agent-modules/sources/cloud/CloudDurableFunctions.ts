import { Type, type Static } from "@sinclair/typebox";

import { cloudVersionSchema } from "./CloudDatabase.js";

export const CLOUD_AUTHORIZATION_EXPIRY_FUNCTION = "cloud.expire-authorization";
export const CLOUD_AUTHORIZATION_EXPIRY_OPERATION = "cloud.authorization-expiry";

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

export const CLOUD_SESSION_REFRESH_FUNCTION = "cloud.refresh-session";
export const CLOUD_SESSION_REFRESH_OPERATION = "cloud.session-refresh";
export const CLOUD_SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

export const cloudSessionRefreshArgumentsSchema = Type.Object(
    { refreshAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) },
    { additionalProperties: false },
);
export const cloudSessionRefreshResultSchema = Type.Null();
export type CloudSessionRefreshArguments = Static<typeof cloudSessionRefreshArgumentsSchema>;
