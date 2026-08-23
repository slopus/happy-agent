/** Installation-wide third-party integration state. */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** The public payload a client renders as a QR code while Happy pairing is active. */
export const happyIntegrationAuthorizationSchema = Type.Object({
    data: Type.String(),
    expiresAt: timestampSchema,
    kind: Type.Literal("qr"),
});
export type HappyIntegrationAuthorization = Static<typeof happyIntegrationAuthorizationSchema>;

/** A stable machine code and its human-readable presentation. */
export const happyIntegrationErrorSchema = Type.Object({
    code: Type.String(),
    message: Type.String(),
});
export type HappyIntegrationError = Static<typeof happyIntegrationErrorSchema>;

/** The complete current Happy integration snapshot. */
export const happyIntegrationSchema = Type.Object({
    authorization: Nullable(happyIntegrationAuthorizationSchema),
    configured: Type.Boolean(),
    error: Nullable(happyIntegrationErrorSchema),
    status: Type.Union([
        Type.Literal("disabled"),
        Type.Literal("disconnected"),
        Type.Literal("pairing"),
        Type.Literal("connecting"),
        Type.Literal("connected"),
        Type.Literal("failed"),
    ]),
    version: resourceVersionSchema,
    updatedAt: timestampSchema,
});
export type HappyIntegration = Static<typeof happyIntegrationSchema>;

/** `GET /v0/integrations/happy` and `POST /v0/integrations/happy/start`. */
export const happyIntegrationResponseSchema = Type.Object({
    integration: happyIntegrationSchema,
});
export type HappyIntegrationResponse = Static<typeof happyIntegrationResponseSchema>;
