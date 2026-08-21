import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";

/** Longest human-readable folder name Happy Terminal stores. */
export const FOLDER_NAME_MAX_LENGTH = 200;
/** Longest description or rules text Happy Terminal stores for one folder. */
export const FOLDER_TEXT_MAX_LENGTH = 8_000;
/**
 * Longest folder icon Happy Terminal stores. Only an emoji is accepted for now, and a single emoji can be a
 * long grapheme cluster once skin tones, gender signs, and zero-width joiners are counted.
 */
export const FOLDER_ICON_MAX_LENGTH = 64;

/**
 * One folder in the virtual tree.
 *
 * Folders are nested only virtually: `parentId` places a folder in the tree, while `path` is a flat
 * storage directory named after the folder's opaque id. Moving a folder rewrites `parentId` and
 * `orderKey` and never touches the filesystem.
 */
export const folderSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        createdAt: Type.Number(),
        /** What the folder is for, shown to people and given to agents working inside it. */
        description: Type.Optional(Type.String()),
        /** A single emoji. Pictures and built-in icons are not stored yet. */
        icon: Type.Optional(Type.String()),
        id: Type.String(),
        name: Type.String(),
        /** Fractional index ordering this folder among every direct child of its parent. */
        orderKey: Type.String(),
        /** Absent for a folder at the root of the tree. */
        parentId: Type.Optional(Type.String()),
        /** Flat storage directory holding this folder's files. */
        path: Type.String(),
        /** Standing instructions every agent working in this folder must follow. */
        rules: Type.Optional(Type.String()),
        /** True only for the root represented by one Murmur folder-sharing group. */
        shared: Type.Boolean(),
        updatedAt: Type.Number(),
        version: Type.Number(),
    },
    { additionalProperties: false },
);
export type Folder = Static<typeof folderSchema>;

export const folderItemTargetSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("project"), projectId: Type.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("workspace"),
            workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            documentId: Type.String({ minLength: 1, maxLength: 128 }),
            kind: Type.Literal("document"),
        },
        { additionalProperties: false },
    ),
]);
export type FolderItemTarget = Static<typeof folderItemTargetSchema>;

export const folderItemSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        createdAt: Type.Number(),
        folderId: Type.String(),
        id: Type.String(),
        /** Shared fractional index ordering this item with the folder's child folders. */
        orderKey: Type.String(),
        target: folderItemTargetSchema,
        updatedAt: Type.Number(),
        version: Type.Number(),
    },
    { additionalProperties: false },
);
export type FolderItem = Static<typeof folderItemSchema>;

export const createFolderItemRequestSchema = Type.Object(
    {
        afterId: Type.Optional(
            Type.Union([Type.String({ maxLength: 128, minLength: 1 }), Type.Null()]),
        ),
        id: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        target: folderItemTargetSchema,
    },
    { additionalProperties: false },
);
export type CreateFolderItemRequest = Static<typeof createFolderItemRequestSchema>;

export const moveFolderItemRequestSchema = Type.Object(
    {
        afterId: Type.Union([Type.String({ maxLength: 128, minLength: 1 }), Type.Null()]),
        folderId: Type.String({ maxLength: 128, minLength: 1 }),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    },
    { additionalProperties: false },
);
export type MoveFolderItemRequest = Static<typeof moveFolderItemRequestSchema>;

export const createFolderRequestSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH })),
        icon: Type.Optional(Type.String({ maxLength: FOLDER_ICON_MAX_LENGTH })),
        /** Client-chosen cuid2 identity. Repeating it returns the same folder. */
        id: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        name: Type.String({ maxLength: FOLDER_NAME_MAX_LENGTH, minLength: 1 }),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        parentId: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        rules: Type.Optional(Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH })),
    },
    { additionalProperties: false },
);
export type CreateFolderRequest = Static<typeof createFolderRequestSchema>;

/**
 * Changing a folder's own fields. An explicit `null` clears an optional field; an absent field is
 * left as it is.
 */
export const updateFolderRequestSchema = Type.Object(
    {
        description: Type.Optional(
            Type.Union([Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH }), Type.Null()]),
        ),
        icon: Type.Optional(
            Type.Union([Type.String({ maxLength: FOLDER_ICON_MAX_LENGTH }), Type.Null()]),
        ),
        name: Type.Optional(Type.String({ maxLength: FOLDER_NAME_MAX_LENGTH, minLength: 1 })),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        rules: Type.Optional(
            Type.Union([Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH }), Type.Null()]),
        ),
    },
    { additionalProperties: false },
);
export type UpdateFolderRequest = Static<typeof updateFolderRequestSchema>;

/**
 * One drag-and-drop. `parentId` is the folder it was dropped into, `null` for the root, and
 * `afterId` is the folder or item it was dropped below, `null` when it landed first. Happy Terminal derives
 * the shared fractional order key from that pair, so a client never invents one.
 */
export const moveFolderRequestSchema = Type.Object(
    {
        afterId: Type.Union([Type.String({ maxLength: 128, minLength: 1 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        parentId: Type.Union([Type.String({ maxLength: 128, minLength: 1 }), Type.Null()]),
    },
    { additionalProperties: false },
);
export type MoveFolderRequest = Static<typeof moveFolderRequestSchema>;

export const folderErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("folder_not_found"),
    Type.Literal("parent_not_found"),
    Type.Literal("sibling_not_found"),
    Type.Literal("item_not_found"),
    Type.Literal("target_not_found"),
    Type.Literal("cycle"),
    Type.Literal("version_conflict"),
    Type.Literal("storage_unavailable"),
    Type.Literal("shared_folder_boundary"),
    Type.Literal("shared_folder_contents_forbidden"),
]);
export type FolderErrorCode = Static<typeof folderErrorCodeSchema>;

export const folderErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            { code: folderErrorCodeSchema, message: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
export type FolderErrorResponse = Static<typeof folderErrorResponseSchema>;

export const listFoldersResponseSchema = Type.Object(
    {
        folders: Type.Array(folderSchema),
        /** Ordered independently inside each item's own folder. */
        items: Type.Array(folderItemSchema),
        /** Durable tree revision represented by this response. */
        revision: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ListFoldersResponse = Static<typeof listFoldersResponseSchema>;

export interface FolderResponse {
    folder: Folder;
    /** Durable tree revision committed with this folder response. */
    revision: number;
}

export const folderItemResponseSchema = Type.Object(
    {
        item: folderItemSchema,
        revision: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type FolderItemResponse = Static<typeof folderItemResponseSchema>;

export interface BaseFolderEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    type: TType;
}

/**
 * A light invalidation for the folder catalog.
 *
 * Folder entities travel by request-response. The durable revision lets a client keep loading until
 * its snapshot includes every invalidation it has already observed.
 */
export type FolderEvent = BaseFolderEvent<
    "folders_changed",
    { mutationId?: string; revision: number }
>;

/**
 * How long a chat may stay in Unsorted before Happy Terminal puts it away. A chat that never files itself into
 * a folder is archived once this has passed since it was created.
 */
export const UNSORTED_SESSION_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1_000;
