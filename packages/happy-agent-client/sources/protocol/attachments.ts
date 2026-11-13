/**
 * Files people attach to messages, under `/v0/agents/:agentId/attachments`. An attachment's ID is
 * the SHA-256 of its bytes, so the same bytes in one conversation are one attachment. The shapes
 * match Happy Cloud's conversation attachments.
 */

import { type Static, Type } from "@sinclair/typebox";

import { timestampSchema } from "./common.js";

/** The largest attachment: 2 GiB. */
export const ATTACHMENT_MAX_SIZE = 2_147_483_648;
/** The most bytes one upload request may carry: 256 MiB. */
export const ATTACHMENT_MAX_REQUEST = 268_435_456;
/** The most files one message may name. */
export const MAX_MESSAGE_FILES = 32;

/** Lowercase hexadecimal SHA-256 of the attachment's bytes. */
export const attachmentIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const attachmentNameSchema = Type.String({ minLength: 1, maxLength: 255 });
const attachmentSizeSchema = Type.Integer({ minimum: 0, maximum: ATTACHMENT_MAX_SIZE });

/** How clients show a file; an unknown kind renders as a file. */
export const attachmentKindSchema = Type.Union([
    Type.Literal("image"),
    Type.Literal("video"),
    Type.Literal("document"),
    Type.Literal("file"),
]);
export type AttachmentKind = Static<typeof attachmentKindSchema>;

/** What an attached file is shown as. Happy Cloud may omit `kind` and the image fields. */
const attachmentDetails = {
    mimeType: Type.String({ minLength: 1, maxLength: 255 }),
    size: attachmentSizeSchema,
    kind: Type.Optional(attachmentKindSchema),
    /** Displayed width in pixels, after EXIF orientation; images only. */
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Displayed height in pixels, after EXIF orientation; images only. */
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Standard base64 ThumbHash placeholder; images only. */
    thumbhash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** Pixels per point from the image's density; absent means 1. */
    scale: Type.Optional(Type.Number({ exclusiveMinimum: 1, maximum: 4 })),
};

/** One file uploaded to a conversation. */
export const attachmentSchema = Type.Object({
    id: attachmentIdSchema,
    name: attachmentNameSchema,
    ...attachmentDetails,
});
export type Attachment = Static<typeof attachmentSchema>;

/** One inclusive byte range, as in `Content-Range`. */
export const attachmentByteRangeSchema = Type.Object({
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
});
export type AttachmentByteRange = Static<typeof attachmentByteRangeSchema>;

/** A chunked upload still missing bytes. */
export const attachmentUploadSchema = Type.Object({
    id: attachmentIdSchema,
    name: attachmentNameSchema,
    size: attachmentSizeSchema,
    /** The byte ranges held, in order and merged. */
    received: Type.Array(attachmentByteRangeSchema),
    /** 24 hours after the upload last received bytes. */
    expiresAt: timestampSchema,
});
export type AttachmentUpload = Static<typeof attachmentUploadSchema>;

/** `201` from either upload route once the attachment exists. */
export const attachmentResponseSchema = Type.Object({ attachment: attachmentSchema });
export type AttachmentResponse = Static<typeof attachmentResponseSchema>;

/** A chunk's answer: the upload while bytes are missing, then the attachment. */
export const attachmentChunkResponseSchema = Type.Union([
    attachmentResponseSchema,
    Type.Object({ upload: attachmentUploadSchema }),
]);
export type AttachmentChunkResponse = Static<typeof attachmentChunkResponseSchema>;

/**
 * An attached file in a message's `content`. `send` takes `attachment` and `name`; the stored
 * message adds what the attachment is.
 */
export const fileBlockSchema = Type.Object({
    type: Type.Literal("file"),
    attachment: attachmentIdSchema,
    name: attachmentNameSchema,
    mimeType: Type.Optional(attachmentDetails.mimeType),
    size: Type.Optional(attachmentDetails.size),
    kind: attachmentDetails.kind,
    width: attachmentDetails.width,
    height: attachmentDetails.height,
    thumbhash: attachmentDetails.thumbhash,
    scale: attachmentDetails.scale,
});
export type FileBlock = Static<typeof fileBlockSchema>;
