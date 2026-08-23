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

const snapshotFields = {
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** The complete current Happy integration snapshot, narrowed by `status`. */
export const happyIntegrationSchema = Type.Union([
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: Type.Null(),
        status: Type.Literal("disabled"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: Nullable(happyIntegrationErrorSchema),
        status: Type.Literal("disconnected"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: happyIntegrationAuthorizationSchema,
        configured: Type.Literal(false),
        error: Type.Null(),
        status: Type.Literal("pairing"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Literal(true),
        error: Type.Null(),
        status: Type.Literal("connecting"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Literal(true),
        error: Type.Null(),
        status: Type.Literal("connected"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: happyIntegrationErrorSchema,
        status: Type.Literal("failed"),
    }),
]);
export type HappyIntegration = Static<typeof happyIntegrationSchema>;

/** The current snapshot returned by every Happy integration operation. */
export const happyIntegrationResponseSchema = Type.Object({
    integration: happyIntegrationSchema,
});
export type HappyIntegrationResponse = Static<typeof happyIntegrationResponseSchema>;
