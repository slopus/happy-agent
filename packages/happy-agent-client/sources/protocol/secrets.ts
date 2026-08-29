/** Global environment-bundle secrets and their typed availability grants. */

import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

/** A human-readable secret description. The daemon trims it before storage. */
export const secretDescriptionSchema = Type.String({
    maxLength: 2_000,
    minLength: 1,
    pattern: "^(?=.*\\S)[\\s\\S]+$",
});
export type SecretDescription = Static<typeof secretDescriptionSchema>;

/** One environment-variable name, safe to expose as metadata. */
export const secretEnvironmentVariableNameSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});
export type SecretEnvironmentVariableName = Static<typeof secretEnvironmentVariableNameSchema>;

/** One write-only environment value. */
export const secretEnvironmentVariableValueSchema = Type.String({
    maxLength: 65_536,
    pattern: "^[^\\u0000]*$",
});
export type SecretEnvironmentVariableValue = Static<typeof secretEnvironmentVariableValueSchema>;

/** A complete write-only environment bundle. */
export const secretEnvironmentSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    {
        additionalProperties: false,
        maxProperties: 256,
        minProperties: 1,
    },
);
export type SecretEnvironment = Static<typeof secretEnvironmentSchema>;

/** A write-only patch; `null` removes one variable. */
export const secretEnvironmentPatchSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    Type.Union([secretEnvironmentVariableValueSchema, Type.Null()]),
    {
        additionalProperties: false,
        maxProperties: 256,
        minProperties: 1,
    },
);
export type SecretEnvironmentPatch = Static<typeof secretEnvironmentPatchSchema>;

/** Safe global secret metadata. Values never appear in this shape. */
export const secretSchema = Type.Object({
    availableToAgents: Type.Boolean(),
    createdAt: timestampSchema,
    description: secretDescriptionSchema,
    /** Explicitly forbidden even though response objects tolerate future metadata fields. */
    environment: Type.Optional(Type.Never()),
    environmentVariables: Type.Array(secretEnvironmentVariableNameSchema, {
        maxItems: 256,
        uniqueItems: true,
    }),
    id: cuid2Schema,
    managed: Type.Boolean(),
    updatedAt: timestampSchema,
    /** Another common value-bearing spelling is forbidden too. */
    values: Type.Optional(Type.Never()),
    version: resourceVersionSchema,
});
export type Secret = Static<typeof secretSchema>;

/** `GET /v0/secrets/:secretId` and successful create/update mutations. */
export const secretResponseSchema = Type.Object({ secret: secretSchema });
export type SecretResponse = Static<typeof secretResponseSchema>;

/** One typed attachment destination. */
export const secretAttachmentTargetTypeSchema = Type.Union([
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("agent"),
]);
export type SecretAttachmentTargetType = Static<typeof secretAttachmentTargetTypeSchema>;

/** A project, workspace, or exact agent receiving one direct grant. */
export const secretAttachmentTargetSchema = Type.Object({
    id: cuid2Schema,
    type: secretAttachmentTargetTypeSchema,
});
export type SecretAttachmentTarget = Static<typeof secretAttachmentTargetSchema>;

/** One immutable direct grant. */
export const secretAttachmentSchema = Type.Object({
    createdAt: timestampSchema,
    id: cuid2Schema,
    secretId: cuid2Schema,
    target: secretAttachmentTargetSchema,
});
export type SecretAttachment = Static<typeof secretAttachmentSchema>;

const secretPageFields = {
    cursor: Type.Optional(cuid2Schema),
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
};

/** `GET /v0/secrets` query, optionally filtered to one exact direct target. */
export const secretListQuerySchema = Type.Union([
    Type.Object(secretPageFields, { additionalProperties: false }),
    Type.Object(
        {
            ...secretPageFields,
            targetId: cuid2Schema,
            targetType: secretAttachmentTargetTypeSchema,
        },
        { additionalProperties: false },
    ),
]);
export type SecretListQuery = Static<typeof secretListQuerySchema>;

/** `GET /v0/secrets` */
export const secretListResponseSchema = Type.Object({
    nextCursor: Nullable(cuid2Schema),
    secrets: Type.Array(secretSchema, { maxItems: 100 }),
});
export type SecretListResponse = Static<typeof secretListResponseSchema>;

/** `POST /v0/secrets` */
export const createSecretRequestSchema = Type.Object(
    {
        availableToAgents: Type.Optional(Type.Boolean()),
        description: secretDescriptionSchema,
        environment: secretEnvironmentSchema,
        id: Type.Optional(cuid2Schema),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
export type CreateSecretRequest = Static<typeof createSecretRequestSchema>;

const updateSecretOptionalFields = {
    availableToAgents: Type.Optional(Type.Boolean()),
    description: Type.Optional(secretDescriptionSchema),
    environment: Type.Optional(secretEnvironmentPatchSchema),
    mutationId: Type.Optional(mutationIdSchema),
};

/** `PATCH /v0/secrets/:secretId`; at least one mutable field is required. */
export const updateSecretRequestSchema = Type.Union([
    Type.Object(
        { ...updateSecretOptionalFields, description: secretDescriptionSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...updateSecretOptionalFields, environment: secretEnvironmentPatchSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...updateSecretOptionalFields, availableToAgents: Type.Boolean() },
        { additionalProperties: false },
    ),
]);
export type UpdateSecretRequest = Static<typeof updateSecretRequestSchema>;

/** Pagination for one secret's direct attachments. */
export const secretAttachmentListQuerySchema = Type.Object(
    {
        cursor: Type.Optional(cuid2Schema),
        limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    },
    { additionalProperties: false },
);
export type SecretAttachmentListQuery = Static<typeof secretAttachmentListQuerySchema>;

/** `GET /v0/secrets/:secretId/attachments` */
export const secretAttachmentListResponseSchema = Type.Object({
    attachments: Type.Array(secretAttachmentSchema, { maxItems: 100 }),
    nextCursor: Nullable(cuid2Schema),
});
export type SecretAttachmentListResponse = Static<typeof secretAttachmentListResponseSchema>;

/** Optional body shared by attach and detach mutations. */
export const secretAttachmentMutationRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type SecretAttachmentMutationRequest = Static<typeof secretAttachmentMutationRequestSchema>;

/** Wire response from attaching one secret. */
export const secretAttachResponseSchema = Type.Object({
    attachment: secretAttachmentSchema,
    created: Type.Boolean(),
});
export type SecretAttachResponse = Static<typeof secretAttachResponseSchema>;

/** Client attach result, preserving new-versus-existing HTTP status. */
export const secretAttachResultSchema = Type.Composite([
    secretAttachResponseSchema,
    Type.Object({ httpStatus: Type.Union([Type.Literal(200), Type.Literal(201)]) }),
]);
export type SecretAttachResult = Static<typeof secretAttachResultSchema>;

/** Wire response from idempotently detaching one secret. */
export const secretDetachResponseSchema = Type.Object({
    attachment: Nullable(secretAttachmentSchema),
    detached: Type.Boolean(),
});
export type SecretDetachResponse = Static<typeof secretDetachResponseSchema>;
