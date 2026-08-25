import { Type, type Static } from "@sinclair/typebox";
import { resourceVersionSchema } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { profileIdSchema, profileSchema, profileVersionSchema } from "../profile/ProfileTypes.js";

const exact = { additionalProperties: false } as const;

/**
 * A 32-byte Murmur value in base64url: an identity key, a session id, or an invitation
 * capability. Everything Murmur exchanges at this level is exactly that size, so one schema
 * covers all three and a value of the wrong length is rejected before it reaches the client.
 */
export const murmurIdentitySchema = Type.String({
    minLength: 43,
    maxLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
export type MurmurIdentity = Static<typeof murmurIdentitySchema>;

/** Whether the relay connection is live, being established, or gone. */
export const murmurConnectionSchema = Type.Union([
    Type.Literal("connecting"),
    Type.Literal("connected"),
    Type.Literal("disconnected"),
]);
export type MurmurConnection = Static<typeof murmurConnectionSchema>;

const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/** Murmur 0.4.5's complete public relationship scan and profile fanout ceiling. */
export const MURMUR_RELATIONSHIP_LIMIT = 256;

/**
 * The person behind one Murmur identity, as it travels between contacts.
 *
 * A peer's profile is the same thing as this installation's own, so it is the profile module's
 * schema rather than a second description of a person that could drift from it. Sharing never
 * invents one: it reads the local profile and puts exactly that on the wire.
 */
export const murmurPeerProfileSchema = profileSchema;
export type MurmurPeerProfile = Static<typeof murmurPeerProfileSchema>;

/**
 * The envelope a profile is wrapped in before Murmur carries it.
 *
 * The version is what lets a future build recognize a profile it cannot read and treat the
 * contact as having no readable profile rather than failing the whole snapshot.
 */
export const murmurCarriedProfileSchema = Type.Object(
    { profile: murmurPeerProfileSchema, version: Type.Literal(1) },
    exact,
);
export type MurmurCarriedProfile = Static<typeof murmurCarriedProfileSchema>;

/** One confirmed contact. A null profile means the peer sent something this build cannot read. */
export const murmurContactRecordSchema = Type.Object(
    {
        identity: murmurIdentitySchema,
        profile: Type.Union([murmurPeerProfileSchema, Type.Null()]),
        status: Type.Union([Type.Literal("active"), Type.Literal("removing")]),
    },
    exact,
);
export type MurmurContactRecord = Static<typeof murmurContactRecordSchema>;

/** Someone who has asked to be a contact and is waiting for an answer. */
export const murmurIncomingRequestSchema = Type.Object(
    {
        id: Type.String({ maxLength: 256, minLength: 1 }),
        identity: murmurIdentitySchema,
        profile: Type.Union([murmurPeerProfileSchema, Type.Null()]),
        sessionId: murmurIdentitySchema,
    },
    exact,
);
export type MurmurIncomingRequest = Static<typeof murmurIncomingRequestSchema>;

/** A request this installation sent, still waiting on the other side. */
export const murmurOutgoingRequestSchema = Type.Object(
    {
        id: murmurIdentitySchema,
        identity: murmurIdentitySchema,
        sessionId: murmurIdentitySchema,
    },
    exact,
);
export type MurmurOutgoingRequest = Static<typeof murmurOutgoingRequestSchema>;

/**
 * Everything a client needs to draw the sharing screen, read in one pass.
 *
 * `version` changes whenever anything here changes, so a client that missed an event can tell
 * that what it is holding is stale without comparing the whole snapshot.
 */
export const murmurSnapshotSchema = Type.Object(
    {
        connection: murmurConnectionSchema,
        contacts: Type.Array(murmurContactRecordSchema, { maxItems: MURMUR_RELATIONSHIP_LIMIT }),
        identity: murmurIdentitySchema,
        incomingRequests: Type.Array(murmurIncomingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        outgoingRequests: Type.Array(murmurOutgoingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        profileId: Type.Union([profileIdSchema, Type.Null()]),
    },
    exact,
);
export type MurmurSnapshot = Static<typeof murmurSnapshotSchema>;

const invitationDigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

const murmurPendingOutgoingRequestSchema = Type.Object(
    {
        id: murmurIdentitySchema,
        identity: Type.Union([murmurIdentitySchema, Type.Null()]),
        invitationDigest: invitationDigestSchema,
        sessionId: Type.Null(),
        status: Type.Literal("pending"),
    },
    exact,
);

const murmurActiveOutgoingRequestSchema = Type.Object(
    {
        id: murmurIdentitySchema,
        identity: murmurIdentitySchema,
        invitationDigest: Type.Union([invitationDigestSchema, Type.Null()]),
        sessionId: murmurIdentitySchema,
        status: Type.Literal("active"),
    },
    exact,
);

export const murmurDurableOutgoingRequestSchema = Type.Union([
    murmurPendingOutgoingRequestSchema,
    murmurActiveOutgoingRequestSchema,
]);
export type MurmurDurableOutgoingRequest = Static<typeof murmurDurableOutgoingRequestSchema>;

const pendingOperationIdSchema = murmurIdentitySchema;
export const murmurPendingOperationSchema = Type.Union([
    Type.Object({ id: pendingOperationIdSchema, type: Type.Literal("enroll") }, exact),
    Type.Object({ id: pendingOperationIdSchema, type: Type.Literal("reset") }, exact),
    Type.Object(
        {
            id: pendingOperationIdSchema,
            identity: murmurIdentitySchema,
            requestId: Type.String({ maxLength: 256, minLength: 1 }),
            sessionId: murmurIdentitySchema,
            type: Type.Literal("accept"),
        },
        exact,
    ),
    Type.Object(
        {
            id: pendingOperationIdSchema,
            identity: murmurIdentitySchema,
            requestId: Type.String({ maxLength: 256, minLength: 1 }),
            sessionId: murmurIdentitySchema,
            type: Type.Literal("reject"),
        },
        exact,
    ),
    Type.Object(
        {
            id: pendingOperationIdSchema,
            identity: murmurIdentitySchema,
            type: Type.Literal("remove"),
        },
        exact,
    ),
]);
export type MurmurPendingOperation = Static<typeof murmurPendingOperationSchema>;

/**
 * Durable authoritative sharing projection plus its private recovery metadata.
 *
 * API reads never rebuild public state from a live Murmur client. A crash may leave one of the
 * private operations pending, but the last public fields and their version remain self-contained
 * and readable until startup reconciliation finishes it.
 */
export const murmurPublicStateSchema = Type.Object(
    {
        connection: murmurConnectionSchema,
        contacts: Type.Array(murmurContactRecordSchema, { maxItems: MURMUR_RELATIONSHIP_LIMIT }),
        enrolled: Type.Boolean(),
        identity: Type.Union([murmurIdentitySchema, Type.Null()]),
        incomingRequests: Type.Array(murmurIncomingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        localProfileVersion: Type.Union([profileVersionSchema, Type.Null()]),
        outgoingRequests: Type.Array(murmurDurableOutgoingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        pendingOperations: Type.Array(murmurPendingOperationSchema, { maxItems: 1_000 }),
        profileId: Type.Union([profileIdSchema, Type.Null()]),
        updatedAt: timestampSchema,
        version: resourceVersionSchema,
    },
    exact,
);
export type MurmurPublicState = Static<typeof murmurPublicStateSchema>;

/** The persisted shape without its monotonic public high-water fields. */
export type MurmurPublicStateContent = Omit<MurmurPublicState, "updatedAt" | "version">;

/** Internal event origin used to keep background callbacks out of API mutation scopes. */
export const murmurEventOriginSchema = Type.Union([
    Type.Literal("mutation"),
    Type.Literal("background"),
]);
export type MurmurEventOrigin = Static<typeof murmurEventOriginSchema>;

/*
 * Keep private session handles in the module snapshot. ApiModule owns the one sanitizing public
 * projection and never serializes them.
 */
export const murmurEnrolledSnapshotSchema = Type.Object(
    {
        connection: murmurConnectionSchema,
        contacts: Type.Array(murmurContactRecordSchema, { maxItems: MURMUR_RELATIONSHIP_LIMIT }),
        identity: murmurIdentitySchema,
        incomingRequests: Type.Array(murmurIncomingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        outgoingRequests: Type.Array(murmurOutgoingRequestSchema, {
            maxItems: MURMUR_RELATIONSHIP_LIMIT,
        }),
        profileId: Type.Union([profileIdSchema, Type.Null()]),
        status: Type.Literal("enrolled"),
        updatedAt: timestampSchema,
        version: resourceVersionSchema,
    },
    exact,
);

/** Stable public state before this installation explicitly enrolls. */
export const murmurUnenrolledSnapshotSchema = Type.Object(
    {
        status: Type.Literal("unenrolled"),
        updatedAt: timestampSchema,
        version: resourceVersionSchema,
    },
    exact,
);

export const murmurSharingSnapshotSchema = Type.Union([
    murmurUnenrolledSnapshotSchema,
    murmurEnrolledSnapshotSchema,
]);
export type MurmurSharingSnapshot = Static<typeof murmurSharingSnapshotSchema>;

/*
 * Legacy aliases below used to describe only the two request-ID maps. They intentionally no
 * longer exist: each pending or active outgoing request is exactly one bounded durable entry.
 */

/** A fresh invitation and the moment it stops being resolvable. */
export const murmurInvitationSchema = Type.Object(
    { expiresAt: timestampSchema, invitation: murmurIdentitySchema },
    exact,
);
export type MurmurInvitation = Static<typeof murmurInvitationSchema>;

/**
 * What one contact request this installation sent looks like to its own caller.
 *
 * The session is the durable handle: the same request read back from a later snapshot carries
 * the same id, so a caller can follow it without holding anything in memory.
 */
export const murmurContactRequestResultSchema = murmurOutgoingRequestSchema;
export type MurmurContactRequestResult = Static<typeof murmurContactRequestResultSchema>;

/** Something about sharing changed; the version identifies the state that resulted. */
export const murmurChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            { origin: murmurEventOriginSchema, version: resourceVersionSchema },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("murmur_changed"),
    },
    exact,
);
export type MurmurChangedEvent = Static<typeof murmurChangedEventSchema>;

/** Told that sharing changed, after the change has happened. */
export type MurmurEventListener = (ctx: Context, event: MurmurChangedEvent) => Promise<void> | void;

/** Ends one subscription. Calling it twice is harmless. */
export type MurmurUnsubscribe = () => void;

/** The durable link between this installation's Murmur identity and the person behind it. */
export const murmurProfileBindingSchema = Type.Object(
    {
        createdAt: timestampSchema,
        murmurIdentity: Type.Union([murmurIdentitySchema, Type.Null()]),
        profileId: profileIdSchema,
    },
    exact,
);
export type MurmurProfileBinding = Static<typeof murmurProfileBindingSchema>;

export type MurmurOperationErrorCode =
    | "conflict"
    | "full"
    | "invalid_invitation"
    | "not_enrolled"
    | "not_found"
    | "unavailable";

/** A sharing-domain failure that the local API can map without exposing Murmur internals. */
export class MurmurOperationError extends Error {
    readonly code: MurmurOperationErrorCode;

    constructor(code: MurmurOperationErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "MurmurOperationError";
        this.code = code;
    }
}
