import { Type, type Static } from "@sinclair/typebox";

import type { HistoryFileBlock } from "../history/index.js";

/** The largest attachment: 2 GiB. */
export const MAX_ATTACHMENT_BYTES = 2_147_483_648;
/** The most bytes one upload request may carry: 256 MiB. */
export const MAX_ATTACHMENT_REQUEST_BYTES = 268_435_456;
/** The most files one message may name. */
export const MAX_MESSAGE_FILES = 32;
/** How long an unsent attachment or an unfinished upload lives after it last received bytes. */
export const ATTACHMENT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** An attachment's ID: the lowercase hexadecimal SHA-256 of its bytes. */
export const attachmentIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** How `send` names an uploaded attachment in its `content`. */
export const fileRequestBlockSchema = Type.Object(
    {
        type: Type.Literal("file"),
        attachment: attachmentIdSchema,
        name: Type.String({ minLength: 1, maxLength: 255 }),
    },
    { additionalProperties: false },
);
export type FileRequestBlock = Static<typeof fileRequestBlockSchema>;

export type AttachmentKind = HistoryFileBlock["kind"];

/** One attachment of one conversation, as stored. */
export interface StoredAttachment {
    readonly agentId: string;
    /** The SHA-256 of the bytes, which also names the stored content. */
    readonly id: string;
    readonly name: string;
    readonly kind: AttachmentKind;
    readonly mimeType: string;
    readonly size: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly thumbhash: string | null;
    readonly scale: number | null;
    /** The uploader, or null for a standalone installation's one person. */
    readonly uploadedBy: string | null;
    readonly createdAt: number;
    /** When a message first sent it; null while unsent. */
    readonly sentAt: number | null;
    /** When an unsent attachment is discarded; null once sent. */
    readonly expiresAt: number | null;
}

/** One inclusive byte range, as in `Content-Range`. */
export interface ByteRange {
    readonly start: number;
    readonly end: number;
}

/** A chunked upload still missing bytes, as stored. */
export interface StoredUpload {
    readonly agentId: string;
    readonly id: string;
    /** The private file the bytes accumulate in; a new one for every upload of the same ID. */
    readonly fileId: string;
    readonly name: string;
    /** The `Content-Type` the upload started with, when it named a specific media type. */
    readonly contentType: string | null;
    readonly size: number;
    /** Held ranges, in order and merged. */
    readonly received: readonly ByteRange[];
    readonly uploadedBy: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
}

/** The attachment object every route answers with. */
export interface AttachmentResource {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    readonly kind: AttachmentKind;
    readonly width?: number;
    readonly height?: number;
    readonly thumbhash?: string;
    readonly scale?: number;
}

/** The upload object a chunk answers with while bytes are missing. */
export interface AttachmentUploadResource {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly received: readonly ByteRange[];
    readonly expiresAt: number;
}

/** A chunk's outcome: the upload while bytes are missing, then the attachment. */
export type AttachmentChunkResult =
    | { readonly attachment: AttachmentResource }
    | { readonly upload: AttachmentUploadResource };

/** Who uploads: a team member's ID, or null for a standalone person. */
export type AttachmentUploader = string | null;

/** A ready attachment's bytes and how to serve them. */
export interface AttachmentContent {
    readonly contentPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mimeType: string;
    readonly name: string;
}

/** Why an attachment operation was refused, in the API's own error codes. */
export class AttachmentError extends Error {
    readonly code:
        | "not_found"
        | "conflict"
        | "invalid_request"
        | "hash_mismatch"
        | "attachment_too_large"
        | "attachment_not_found";

    constructor(code: AttachmentError["code"], message: string) {
        super(message);
        this.name = "AttachmentError";
        this.code = code;
    }
}

/** The public object for one stored attachment. */
export function attachmentResource(row: StoredAttachment): AttachmentResource {
    return {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        kind: row.kind,
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
        ...(row.thumbhash === null ? {} : { thumbhash: row.thumbhash }),
        ...(row.scale === null ? {} : { scale: row.scale }),
    };
}

/** The public object for one unfinished upload. */
export function uploadResource(row: StoredUpload): AttachmentUploadResource {
    return {
        id: row.id,
        name: row.name,
        size: row.size,
        received: row.received,
        expiresAt: row.expiresAt,
    };
}
