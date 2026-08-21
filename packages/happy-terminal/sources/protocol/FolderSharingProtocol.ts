import { Type, type Static } from "@sinclair/typebox";

import {
    FOLDER_ICON_MAX_LENGTH,
    FOLDER_NAME_MAX_LENGTH,
    FOLDER_TEXT_MAX_LENGTH,
} from "./FolderProtocol.js";

const exact = { additionalProperties: false } as const;
const sharedFolderIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export const MAX_SHARED_FOLDER_NODES = 10_000;

/** One virtual folder replicated through a Murmur folder group. */
export const sharedFolderNodeSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH })),
        icon: Type.Optional(Type.String({ maxLength: FOLDER_ICON_MAX_LENGTH })),
        id: sharedFolderIdSchema,
        name: Type.String({ minLength: 1, maxLength: FOLDER_NAME_MAX_LENGTH }),
        /** Zero-based position among the node's direct sibling folders. */
        order: Type.Integer({ minimum: 0, maximum: 10_000 }),
        parentId: Type.Optional(sharedFolderIdSchema),
        rules: Type.Optional(Type.String({ maxLength: FOLDER_TEXT_MAX_LENGTH })),
    },
    exact,
);
export type SharedFolderNode = Static<typeof sharedFolderNodeSchema>;

/** Current complete virtual tree for one shared root. Local paths never cross the wire. */
export const sharedFolderStateSchema = Type.Object(
    {
        folders: Type.Array(sharedFolderNodeSchema, {
            minItems: 1,
            maxItems: MAX_SHARED_FOLDER_NODES,
        }),
        rootId: sharedFolderIdSchema,
    },
    exact,
);
export type SharedFolderState = Static<typeof sharedFolderStateSchema>;

/** Immutable Murmur group descriptor: the invitation package carries current initial state. */
export const folderShareDescriptorSchema = Type.Object(
    {
        kind: Type.Literal("folder_share"),
        /** Stable creation intent used to recover a creator-side crash after Murmur persists. */
        shareId: Type.String({ minLength: 1, maxLength: 256 }),
        state: sharedFolderStateSchema,
        version: Type.Literal(1),
    },
    exact,
);
export type FolderShareDescriptor = Static<typeof folderShareDescriptorSchema>;

export const folderShareOperationSchema = Type.Union([
    Type.Object(
        {
            node: sharedFolderNodeSchema,
            type: Type.Literal("upsert"),
        },
        exact,
    ),
    Type.Object(
        {
            folderId: sharedFolderIdSchema,
            type: Type.Literal("remove"),
        },
        exact,
    ),
]);
export type FolderShareOperation = Static<typeof folderShareOperationSchema>;

/**
 * One idempotent semantic operation batch.
 *
 * Murmur orders each recipient inbox but not the whole group. Each folder is an independent
 * last-writer-wins register keyed by this Lamport clock and authenticated sender identity, so
 * concurrent changes to different folders merge instead of one complete tree replacing another.
 */
export const folderSharePacketSchema = Type.Object(
    {
        clock: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        operationId: Type.String({ minLength: 1, maxLength: 256 }),
        operations: Type.Array(folderShareOperationSchema, {
            minItems: 1,
            maxItems: MAX_SHARED_FOLDER_NODES,
        }),
        type: Type.Literal("operations"),
        version: Type.Literal(1),
    },
    exact,
);
export type FolderSharePacket = Static<typeof folderSharePacketSchema>;
