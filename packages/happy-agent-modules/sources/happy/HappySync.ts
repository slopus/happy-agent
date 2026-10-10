import { createHash } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";

import { happyEncryptionVariantSchema } from "./HappyCredentials.js";

const exact = { additionalProperties: false } as const;

/** How many messages may wait for delivery for one session before projection defers. */
export const MAX_HAPPY_OUTBOX_MESSAGES = 10_000;

/** How large one encoded message may be. A larger one can never be delivered, so it is refused. */
export const MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS = 4_000_000;

/** How many messages one event may produce. */
export const MAX_HAPPY_MESSAGES_PER_EVENT = 512;

export const happyProjectionStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("stalled"),
]);
export type HappyProjectionStatus = Static<typeof happyProjectionStatusSchema>;

/**
 * Why projection stopped advancing.
 *
 * `capacity` clears itself once the phone catches up. `event_too_large` does
 * not: that message can never be delivered as it stands.
 */
export const happyProjectionStallCauseSchema = Type.Union([
    Type.Literal("capacity"),
    Type.Literal("event_too_large"),
]);
export type HappyProjectionStallCause = Static<typeof happyProjectionStallCauseSchema>;

const happyAgentIdSchema = Type.String({ maxLength: 128, minLength: 1 });
const happySessionIdSchema = Type.String({ maxLength: 128, minLength: 1 });
const happyLocalIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const happyTimestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/** One message waiting to be delivered to Happy, before encryption. */
export const happyOutboxMessageSchema = Type.Object(
    {
        localId: happyLocalIdSchema,
        payload: Type.Unknown(),
    },
    exact,
);
export type HappyOutboxMessage = Static<typeof happyOutboxMessageSchema>;

/** A queued message read back for delivery, in the order it was enqueued. */
export const happyOutboxEntrySchema = Type.Object(
    {
        localId: happyLocalIdSchema,
        payload: Type.Unknown(),
        position: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type HappyOutboxEntry = Static<typeof happyOutboxEntrySchema>;

/** What this agent's Happy synchronization knows about itself. */
export const happySyncSessionSchema = Type.Object(
    {
        agentId: happyAgentIdSchema,
        createdAt: happyTimestampSchema,
        /**
         * The wrapped data key this daemon sends for the current tag, recorded before the first
         * request so every retry sends the same bytes. Happy stores it verbatim, so the key it
         * returns for this tag is this daemon's exactly when the bytes match. Absent for legacy
         * accounts and for sessions published before keys were recorded.
         */
        dataEncryptionKeyBase64: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        /** Identifies the account and server these rows belong to; a change resets them. */
        credentialFingerprint: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionKeyBase64: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionVariant: happyEncryptionVariantSchema,
        /** Whether the history that existed before Happy connected has been queued. */
        historyBackfilled: Type.Boolean(),
        /** The newest message sequence received from Happy. */
        lastRemoteSeq: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        /** The newest event projected into the outbox, if any. */
        projectedEventId: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        projectionError: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
        projectionStallCause: Type.Optional(happyProjectionStallCauseSchema),
        projectionStatus: happyProjectionStatusSchema,
        remoteSessionId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        sessionId: happySessionIdSchema,
        /** Makes remote session creation idempotent across restarts. */
        tag: Type.String({ maxLength: 256, minLength: 1 }),
        updatedAt: happyTimestampSchema,
    },
    exact,
);
export type HappySyncSession = Static<typeof happySyncSessionSchema>;

/** What the sync service supplies when it attaches an agent to Happy. */
export const happySyncSessionInputSchema = Type.Object(
    {
        agentId: happyAgentIdSchema,
        credentialFingerprint: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionKeyBase64: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionVariant: happyEncryptionVariantSchema,
        sessionId: happySessionIdSchema,
    },
    exact,
);
export type HappySyncSessionInput = Static<typeof happySyncSessionInputSchema>;

/** What projecting one event did. */
export const happyProjectionOutcomeSchema = Type.Union([
    Type.Object({ kind: Type.Literal("projected"), deferred: Type.Boolean() }, exact),
    Type.Object({ kind: Type.Literal("already_projected") }, exact),
    Type.Object({ kind: Type.Literal("not_attached") }, exact),
    Type.Object({ kind: Type.Literal("stalled"), cause: happyProjectionStallCauseSchema }, exact),
]);
export type HappyProjectionOutcome = Static<typeof happyProjectionOutcomeSchema>;

/**
 * Builds the tag that makes remote session creation idempotent.
 *
 * Happy answers a creation with an existing tag with the session it already holds, keeping that
 * session's data key and ignoring the one sent. A tag reused with a new key therefore leaves the
 * daemon encrypting with a key the phone does not have, so the tag carries a digest of the key.
 */
export function happySessionTag(sessionId: string, encryptionKeyBase64: string): string {
    const digest = createHash("sha256")
        .update("happy-session-tag\0")
        .update(encryptionKeyBase64)
        .digest("hex")
        .slice(0, 16);
    return `rig:${sessionId}#${digest}`;
}
