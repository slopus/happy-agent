import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";
import { happyAgentProfileIdSchema, happyAgentProfileIdentitySchema } from "./ProfileProtocol.js";

export const DOCUMENT_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_UPDATE_MAX_BYTES = 1024 * 1024;
export const DOCUMENT_UPDATE_PAGE_MAX_LIMIT = 1_000;
export const DOCUMENT_UPDATE_RETENTION_MAX_COUNT = 10_000;
export const DOCUMENT_UPDATE_RETENTION_MAX_BYTES = 64 * 1024 * 1024;

export const documentUnreadCursorSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const documentCreatedBySchema = Type.Object(
    {
        instanceId: p2pInstanceIdSchema,
        profileId: Type.Optional(happyAgentProfileIdSchema),
    },
    { additionalProperties: false },
);
export type DocumentCreatedBy = Static<typeof documentCreatedBySchema>;

export const documentSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0 }),
        createdBy: documentCreatedBySchema,
        firstRetainedVersion: Type.Integer({ minimum: 1 }),
        id: Type.String(),
        mimeType: Type.String(),
        state: Type.Unknown(),
        unreadCursor: Type.Optional(documentUnreadCursorSchema),
        updatedAt: Type.Integer({ minimum: 0 }),
        version: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
);
export type Document = Static<typeof documentSchema>;

export const documentUpdateSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0 }),
        documentId: Type.String(),
        id: documentUnreadCursorSchema,
        update: Type.Unknown(),
        version: Type.Integer({ minimum: 2 }),
    },
    { additionalProperties: false },
);
export type DocumentUpdate = Static<typeof documentUpdateSchema>;

export const createDocumentRequestSchema = Type.Object(
    {
        id: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        identity: Type.Optional(happyAgentProfileIdentitySchema),
        mimeType: Type.String({ maxLength: 256, minLength: 1 }),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        state: Type.Unknown(),
        unreadCursor: Type.Optional(documentUnreadCursorSchema),
    },
    { additionalProperties: false },
);
export type CreateDocumentRequest = Static<typeof createDocumentRequestSchema>;

export const writeDocumentRequestSchema = Type.Object(
    {
        mimeType: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        state: Type.Unknown(),
        unreadCursor: Type.Optional(Type.Union([documentUnreadCursorSchema, Type.Null()])),
        update: Type.Unknown(),
    },
    { additionalProperties: false },
);
export type WriteDocumentRequest = Static<typeof writeDocumentRequestSchema>;

export const listDocumentUpdatesRequestSchema = Type.Object(
    {
        afterVersion: Type.Integer({ minimum: 0 }),
        limit: Type.Optional(Type.Integer({ maximum: DOCUMENT_UPDATE_PAGE_MAX_LIMIT, minimum: 1 })),
    },
    { additionalProperties: false },
);
export type ListDocumentUpdatesRequest = Static<typeof listDocumentUpdatesRequestSchema>;

export const documentResponseSchema = Type.Object(
    { document: documentSchema },
    { additionalProperties: false },
);
export type DocumentResponse = Static<typeof documentResponseSchema>;

export const documentUpdatePageSchema = Type.Object(
    {
        currentVersion: Type.Integer({ minimum: 1 }),
        firstRetainedVersion: Type.Integer({ minimum: 1 }),
        gap: Type.Boolean(),
        hasMore: Type.Boolean(),
        nextAfterVersion: Type.Integer({ minimum: 0 }),
        updates: Type.Array(documentUpdateSchema, { maxItems: DOCUMENT_UPDATE_PAGE_MAX_LIMIT }),
    },
    { additionalProperties: false },
);
export type DocumentUpdatePage = Static<typeof documentUpdatePageSchema>;

export const documentErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("document_not_found"),
    Type.Literal("version_conflict"),
]);
export type DocumentErrorCode = Static<typeof documentErrorCodeSchema>;
export const documentErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            { code: documentErrorCodeSchema, message: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
export type DocumentErrorResponse = Static<typeof documentErrorResponseSchema>;

export interface DocumentEvent {
    createdAt: number;
    data: { documentId: string; mutationId?: string; version: number };
    id: EventId;
    type: "document_changed";
}
