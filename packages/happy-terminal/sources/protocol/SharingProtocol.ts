import { Type, type Static } from "@sinclair/typebox";

import { happyAgentProfileIdSchema, happyAgentProfileSchema } from "./ProfileProtocol.js";

const exact = { additionalProperties: false } as const;

export const sharingIdentitySchema = Type.String({
    minLength: 43,
    maxLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
export type SharingIdentity = Static<typeof sharingIdentitySchema>;

export const sharingConnectionSchema = Type.Union([
    Type.Literal("connecting"),
    Type.Literal("connected"),
    Type.Literal("disconnected"),
]);
export type SharingConnection = Static<typeof sharingConnectionSchema>;

export const sharingContactSchema = Type.Object(
    {
        identity: sharingIdentitySchema,
        profile: Type.Union([happyAgentProfileSchema, Type.Null()]),
        status: Type.Union([Type.Literal("active"), Type.Literal("removing")]),
    },
    exact,
);
export type SharingContact = Static<typeof sharingContactSchema>;

export const sharingContactRequestSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        identity: sharingIdentitySchema,
        profile: Type.Union([happyAgentProfileSchema, Type.Null()]),
        sessionId: sharingIdentitySchema,
    },
    exact,
);
export type SharingContactRequest = Static<typeof sharingContactRequestSchema>;

export const sharingOutgoingContactRequestSchema = Type.Object(
    {
        id: sharingIdentitySchema,
        identity: sharingIdentitySchema,
        sessionId: sharingIdentitySchema,
    },
    exact,
);
export type SharingOutgoingContactRequest = Static<typeof sharingOutgoingContactRequestSchema>;

export const folderShareStatusSchema = Type.Object(
    {
        error: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
        groupId: sharingIdentitySchema,
        lastSyncedAt: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        members: Type.Array(sharingIdentitySchema, { maxItems: 256 }),
        rootFolderId: Type.String({ minLength: 1, maxLength: 128 }),
        status: Type.Union([
            Type.Literal("syncing"),
            Type.Literal("synced"),
            Type.Literal("error"),
        ]),
    },
    exact,
);
export type FolderShareStatus = Static<typeof folderShareStatusSchema>;

export const createFolderShareRequestSchema = Type.Object(
    {
        contacts: Type.Array(sharingIdentitySchema, {
            minItems: 1,
            maxItems: 255,
            uniqueItems: true,
        }),
        folderId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    exact,
);
export type CreateFolderShareRequest = Static<typeof createFolderShareRequestSchema>;

export const sharingSnapshotSchema = Type.Object(
    {
        connection: sharingConnectionSchema,
        contacts: Type.Array(sharingContactSchema, { maxItems: 10_000 }),
        folderShares: Type.Array(folderShareStatusSchema, { maxItems: 1_000 }),
        identity: sharingIdentitySchema,
        incomingRequests: Type.Array(sharingContactRequestSchema, { maxItems: 1_000 }),
        outgoingRequests: Type.Array(sharingOutgoingContactRequestSchema, {
            maxItems: 1_000,
        }),
        profileId: Type.Union([happyAgentProfileIdSchema, Type.Null()]),
        version: Type.String({ minLength: 1, maxLength: 256 }),
    },
    exact,
);
export type SharingSnapshot = Static<typeof sharingSnapshotSchema>;

export const createSharingInvitationResponseSchema = Type.Object(
    {
        expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        invitation: sharingIdentitySchema,
    },
    exact,
);
export type CreateSharingInvitationResponse = Static<typeof createSharingInvitationResponseSchema>;

export const requestSharingContactRequestSchema = Type.Object(
    { invitation: sharingIdentitySchema },
    exact,
);
export type RequestSharingContactRequest = Static<typeof requestSharingContactRequestSchema>;

export const sharingOutgoingContactRequestResponseSchema = Type.Object(
    { request: sharingOutgoingContactRequestSchema },
    exact,
);
export type SharingOutgoingContactRequestResponse = Static<
    typeof sharingOutgoingContactRequestResponseSchema
>;

export const sharingChangedEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        data: Type.Object({ version: Type.String({ minLength: 1, maxLength: 256 }) }, exact),
        id: Type.String({ minLength: 1, maxLength: 256 }),
        type: Type.Literal("sharing_changed"),
    },
    exact,
);
export type SharingChangedEvent = Static<typeof sharingChangedEventSchema>;
