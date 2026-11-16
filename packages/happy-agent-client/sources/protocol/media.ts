/** Global content-addressed media, shared by attachments, tool calls, and artifacts. */
import { type Static, Type } from "@sinclair/typebox";

import {
    attachmentIdSchema,
    attachmentKindSchema,
    attachmentSchema,
    attachmentUploadSchema,
} from "./attachments.js";

export { mediaPreviewSchema, type MediaPreview } from "./mediaMetadata.js";

/** Lowercase hexadecimal SHA-256 of the media's original bytes. */
export const mediaIdSchema = attachmentIdSchema;

/** Media has no name: each message, tool call, or artifact names its own use. */
export const mediaSchema = Type.Object({
    ...Type.Omit(attachmentSchema, ["name"]).properties,
    kind: attachmentKindSchema,
});
export type Media = Static<typeof mediaSchema>;

/** A global upload still missing bytes; the upload retains its initiating name. */
export const mediaUploadSchema = attachmentUploadSchema;
export type MediaUpload = Static<typeof mediaUploadSchema>;

/** `201` from a global upload once the media exists. */
export const mediaResponseSchema = Type.Object({ media: mediaSchema });
export type MediaResponse = Static<typeof mediaResponseSchema>;

/** A chunk or probe answers missing ranges or the complete media. */
export const mediaChunkResponseSchema = Type.Union([
    mediaResponseSchema,
    Type.Object({ upload: mediaUploadSchema }),
]);
export type MediaChunkResponse = Static<typeof mediaChunkResponseSchema>;

/** A phone-playable video, a tile's still, or a viewer's first picture. */
export const mediaVariantSchema = Type.Union([
    Type.Literal("play"),
    Type.Literal("preview"),
    Type.Literal("large"),
]);
export type MediaVariant = Static<typeof mediaVariantSchema>;

/** No variant means the original bytes. */
export const mediaReadQuerySchema = Type.Object(
    { variant: Type.Optional(mediaVariantSchema) },
    { additionalProperties: false },
);
export type MediaReadQuery = Static<typeof mediaReadQuerySchema>;
