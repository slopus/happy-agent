import { Type, type Static } from "@sinclair/typebox";

import { cloudVersionSchema } from "./CloudDatabase.js";

export const CLOUD_AUTHORIZATION_EXPIRY_FUNCTION = "cloud.expire-authorization";
export const CLOUD_AUTHORIZATION_EXPIRY_OPERATION = "cloud.authorization-expiry";
export const CLOUD_AUTHORIZATION_LOCK = "cloud.authorization";

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
