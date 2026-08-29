import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import {
    secretDescriptionSchema,
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
} from "./Secret.js";

/** Installation-wide secret name. Generated values remain valid CUID2 identities. */
export const secretApiIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9_-]*$",
});

export const secretApiVersionSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const secretApiTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const secretApiEnvironmentSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    { additionalProperties: false, minProperties: 1, maxProperties: 256 },
);

export const secretApiEnvironmentPatchSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    Type.Union([secretEnvironmentVariableValueSchema, Type.Null()]),
    { additionalProperties: false, minProperties: 1, maxProperties: 256 },
);

export const secretApiRecordSchema = Type.Object(
    {
        id: secretApiIdSchema,
        description: secretDescriptionSchema,
        environmentVariables: Type.Array(secretEnvironmentVariableNameSchema, {
            maxItems: 256,
            uniqueItems: true,
        }),
        managed: Type.Boolean(),
        availableToAgents: Type.Boolean(),
        version: secretApiVersionSchema,
        createdAt: secretApiTimestampSchema,
        updatedAt: secretApiTimestampSchema,
    },
    { additionalProperties: false },
);

export const secretApiTargetTypeSchema = Type.Union([
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("agent"),
]);

export const secretApiTargetSchema = Type.Object(
    { type: secretApiTargetTypeSchema, id: cuid2Schema },
    { additionalProperties: false },
);

export const secretApiAttachmentSchema = Type.Object(
    {
        id: cuid2Schema,
        secretId: secretApiIdSchema,
        target: secretApiTargetSchema,
        createdAt: secretApiTimestampSchema,
    },
    { additionalProperties: false },
);

export const secretApiCreateInputSchema = Type.Object(
    {
        id: Type.Optional(secretApiIdSchema),
        description: secretDescriptionSchema,
        environment: secretApiEnvironmentSchema,
        availableToAgents: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export const secretApiUpdateInputSchema = Type.Object(
    {
        description: Type.Optional(secretDescriptionSchema),
        environment: Type.Optional(secretApiEnvironmentPatchSchema),
        availableToAgents: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false, minProperties: 1 },
);

export const secretApiListQuerySchema = Type.Object(
    {
        cursor: Type.Optional(secretApiIdSchema),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        target: Type.Optional(secretApiTargetSchema),
    },
    { additionalProperties: false },
);

export const secretApiAttachmentListQuerySchema = Type.Object(
    {
        cursor: Type.Optional(cuid2Schema),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
    },
    { additionalProperties: false },
);

export const secretApiPageSchema = Type.Object(
    {
        secrets: Type.Array(secretApiRecordSchema, { maxItems: 100 }),
        nextCursor: Type.Union([secretApiIdSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

export const secretApiAttachmentPageSchema = Type.Object(
    {
        attachments: Type.Array(secretApiAttachmentSchema, { maxItems: 100 }),
        nextCursor: Type.Union([cuid2Schema, Type.Null()]),
    },
    { additionalProperties: false },
);

export type SecretApiId = Static<typeof secretApiIdSchema>;
export type SecretApiVersion = Static<typeof secretApiVersionSchema>;
export type SecretApiEnvironment = Static<typeof secretApiEnvironmentSchema>;
export type SecretApiEnvironmentPatch = Static<typeof secretApiEnvironmentPatchSchema>;
export type SecretApiRecord = Static<typeof secretApiRecordSchema>;
export type SecretApiTargetType = Static<typeof secretApiTargetTypeSchema>;
export type SecretApiTarget = Static<typeof secretApiTargetSchema>;
export type SecretApiAttachment = Static<typeof secretApiAttachmentSchema>;
export type SecretApiCreateInput = Static<typeof secretApiCreateInputSchema>;
export type SecretApiUpdateInput = Static<typeof secretApiUpdateInputSchema>;
export type SecretApiListQuery = Static<typeof secretApiListQuerySchema>;
export type SecretApiAttachmentListQuery = Static<typeof secretApiAttachmentListQuerySchema>;
export type SecretApiPage = Static<typeof secretApiPageSchema>;
export type SecretApiAttachmentPage = Static<typeof secretApiAttachmentPageSchema>;

export class SecretApiInputError extends Error {}

export class SecretApiConflictError extends Error {
    readonly current: SecretApiRecord | undefined;

    constructor(message: string, current?: SecretApiRecord) {
        super(message);
        this.current = current;
    }
}
