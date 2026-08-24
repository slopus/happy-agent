/** Sharing: this installation's opt-in contacts and pending relationships. */

import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

const base64Url43Options = {
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{43}$",
} as const;

/** A public installation identity. It is opaque and compared only for equality. */
export const sharingIdentitySchema = Type.String(base64Url43Options);
export type SharingIdentity = Static<typeof sharingIdentitySchema>;

/** A short-lived, single-use invitation capability. Treat this value as sensitive. */
export const sharingInvitationSchema = Type.String(base64Url43Options);
export type SharingInvitation = Static<typeof sharingInvitationSchema>;

/** An opaque incoming-request target, with no ordering or identity semantics. */
export const sharingRequestIdSchema = Type.String({ maxLength: 256, minLength: 1 });
export type SharingRequestId = Static<typeof sharingRequestIdSchema>;

/** Runtime connectivity to the managed sharing service. */
export const sharingConnectionSchema = Type.Union([
    Type.Literal("connecting"),
    Type.Literal("connected"),
    Type.Literal("disconnected"),
]);
export type SharingConnection = Static<typeof sharingConnectionSchema>;

/** A peer photo's public ThumbHash placeholder. No image bytes endpoint exists for peers. */
export const sharingPeerPhotoSchema = Type.Object({ thumbhash: Type.String() });
export type SharingPeerPhoto = Static<typeof sharingPeerPhotoSchema>;

/**
 * The sanitized public projection of another person's profile.
 *
 * The daemon owns sanitization at the serialization boundary. Like every
 * protocol-22 public schema, this remains open to future additive fields so an
 * older client can consume a response from a newer compatible daemon.
 */
export const sharingPeerProfileSchema = Type.Object({
    email: Nullable(Type.String()),
    name: Nullable(Type.String()),
    photo: Nullable(sharingPeerPhotoSchema),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type SharingPeerProfile = Static<typeof sharingPeerProfileSchema>;

/** A durable mutual contact, possibly still propagating removal to its peer. */
export const sharingContactSchema = Type.Object({
    identity: sharingIdentitySchema,
    profile: Nullable(sharingPeerProfileSchema),
    status: Type.Union([Type.Literal("active"), Type.Literal("removing")]),
});
export type SharingContact = Static<typeof sharingContactSchema>;

/** A request received from a peer and waiting for this installation's decision. */
export const sharingIncomingRequestSchema = Type.Object({
    id: sharingRequestIdSchema,
    identity: sharingIdentitySchema,
    profile: Nullable(sharingPeerProfileSchema),
});
export type SharingIncomingRequest = Static<typeof sharingIncomingRequestSchema>;

/** A request this installation sent by redeeming another person's invitation. */
export const sharingOutgoingRequestSchema = Type.Object({
    id: Type.String(base64Url43Options),
    identity: sharingIdentitySchema,
});
export type SharingOutgoingRequest = Static<typeof sharingOutgoingRequestSchema>;

const sharingSnapshotFields = {
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** The stable sharing snapshot before this installation opts in. */
export const unenrolledSharingSchema = Type.Object({
    ...sharingSnapshotFields,
    status: Type.Literal("unenrolled"),
});
export type UnenrolledSharing = Static<typeof unenrolledSharingSchema>;

/** The complete current sharing snapshot after enrollment. */
export const enrolledSharingSchema = Type.Object({
    ...sharingSnapshotFields,
    connection: sharingConnectionSchema,
    contacts: Type.Array(sharingContactSchema, { maxItems: 10_000 }),
    identity: sharingIdentitySchema,
    incomingRequests: Type.Array(sharingIncomingRequestSchema, { maxItems: 1_000 }),
    outgoingRequests: Type.Array(sharingOutgoingRequestSchema, { maxItems: 1_000 }),
    status: Type.Literal("enrolled"),
});
export type EnrolledSharing = Static<typeof enrolledSharingSchema>;

/** The installation-wide sharing snapshot, discriminated by enrollment status. */
export const sharingSchema = Type.Union([unenrolledSharingSchema, enrolledSharingSchema]);
export type Sharing = Static<typeof sharingSchema>;

/** `GET /v0/sharing` and every state-changing sharing mutation return this. */
export const sharingResponseSchema = Type.Object({ sharing: sharingSchema });
export type SharingResponse = Static<typeof sharingResponseSchema>;

/** The optional body shared by enrollment, resolution, removal, and reset. */
export const sharingMutationRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type SharingMutationRequest = Static<typeof sharingMutationRequestSchema>;

/** `POST /v0/sharing/invitations` returns one sensitive capability exactly once. */
export const sharingInvitationResponseSchema = Type.Object({
    expiresAt: timestampSchema,
    invitation: sharingInvitationSchema,
});
export type SharingInvitationResponse = Static<typeof sharingInvitationResponseSchema>;

/** `POST /v0/sharing/requests` — redeem another person's invitation. */
export const sharingRequestSubmissionSchema = Type.Object({
    invitation: sharingInvitationSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type SharingRequestSubmission = Static<typeof sharingRequestSubmissionSchema>;
