import { Type, type Static } from "@sinclair/typebox";

import { environmentVariableNameSchema, secretIdSchema } from "./ClientProtocolTypes.js";

const attachmentBase = {
    downloadUrl: Type.Optional(Type.String({ minLength: 1 })),
    id: Type.String({ minLength: 1 }),
    source: Type.String({
        description:
            "Origin URL or Happy Terminal-scoped local locator such as generated/file.png; never a host or execution-environment path.",
        minLength: 1,
    }),
};

export const AttachmentImagePreviewSchema = Type.Object(
    {
        downloadUrl: Type.Optional(Type.String({ minLength: 1 })),
        height: Type.Integer({ minimum: 1 }),
        mediaType: Type.Literal("image/png"),
        path: Type.String({
            description: "Happy Terminal-scoped generated-media locator.",
            minLength: 1,
        }),
        thumbhash: Type.String({ minLength: 1 }),
        width: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
);

export const SecretRequestAttachmentSchema = Type.Object(
    {
        description: Type.String({
            description: "Description to use when creating or updating the secret.",
            minLength: 1,
        }),
        environmentVariables: Type.Array(environmentVariableNameSchema, {
            description: "Environment variable names whose values the user needs to provide.",
            minItems: 1,
            uniqueItems: true,
        }),
        id: Type.String({ minLength: 1 }),
        instructions: Type.String({
            description: "Human-readable guidance for obtaining and entering the secret values.",
            minLength: 1,
        }),
        kind: Type.Literal("secret_request"),
        operation: Type.Union([Type.Literal("create"), Type.Literal("update")]),
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

export const AttachmentSchema = Type.Union([
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            height: Type.Integer({ minimum: 1 }),
            kind: Type.Literal("image"),
            mediaType: Type.String({ minLength: 1 }),
            name: Type.String({ minLength: 1 }),
            thumbhash: Type.String({ minLength: 1 }),
            width: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            duration: Type.Number({ description: "Duration in seconds.", minimum: 0 }),
            height: Type.Integer({ minimum: 1 }),
            kind: Type.Literal("video"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
            preview: AttachmentImagePreviewSchema,
            width: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            duration: Type.Number({ description: "Duration in seconds.", minimum: 0 }),
            kind: Type.Literal("audio"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            description: Type.Optional(Type.String()),
            image: Type.Optional(Type.String()),
            kind: Type.Literal("url"),
            siteName: Type.Optional(Type.String()),
            title: Type.String(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            kind: Type.Literal("file"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            description: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
            image: Type.String({ minLength: 1 }),
            kind: Type.Literal("applet"),
            name: Type.String({ minLength: 1 }),
            path: Type.Optional(Type.String({ minLength: 1 })),
            query: Type.Optional(
                Type.Record(Type.String({ minLength: 1 }), Type.String(), {
                    description: "Query values forwarded when the applet opens.",
                }),
            ),
            thumbhash: Type.String({ minLength: 1 }),
            applet: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    SecretRequestAttachmentSchema,
]);

export type AttachmentImagePreview = Static<typeof AttachmentImagePreviewSchema>;
export type SecretRequestAttachment = Static<typeof SecretRequestAttachmentSchema>;
export type Attachment = Static<typeof AttachmentSchema>;
