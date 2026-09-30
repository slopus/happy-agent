/** GPT-Live voice sessions. Provider credentials and wire events stay on the daemon. */
import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

const liveIdSchema = Type.String({ minLength: 2, maxLength: 32, pattern: "^[a-z][a-z0-9]*$" });

export const liveCredentialSchema = Type.Object({
    type: Type.Union([Type.Literal("codex_subscription"), Type.Literal("openai_api_key")]),
    providerId: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
});
export type LiveCredential = Static<typeof liveCredentialSchema>;

/** Request selection is closed; resource responses remain forward-compatible. */
export const liveCredentialRequestSchema = Type.Object(liveCredentialSchema.properties, {
    additionalProperties: false,
});

export const liveWatchedAgentIdsSchema = Type.Array(liveIdSchema, {
    maxItems: 32,
    uniqueItems: true,
});

export const liveSessionStatusSchema = Type.Union([
    Type.Literal("starting"),
    Type.Literal("active"),
    Type.Literal("closing"),
    Type.Literal("closed"),
    Type.Literal("failed"),
]);
export type LiveSessionStatus = Static<typeof liveSessionStatusSchema>;

export const liveSessionUsageSchema = Type.Union([
    Type.Object({ seconds: Nullable(Type.Number({ minimum: 0 })), final: Type.Literal(false) }),
    Type.Object({ seconds: Type.Number({ minimum: 0 }), final: Type.Literal(true) }),
]);
export type LiveSessionUsage = Static<typeof liveSessionUsageSchema>;

export const liveSessionSchema = Type.Object({
    id: liveIdSchema,
    agentId: liveIdSchema,
    credential: liveCredentialSchema,
    watchedAgentIds: liveWatchedAgentIdsSchema,
    status: liveSessionStatusSchema,
    usage: liveSessionUsageSchema,
    error: Nullable(Type.String()),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    endedAt: Nullable(timestampSchema),
    version: resourceVersionSchema,
});
export type LiveSession = Static<typeof liveSessionSchema>;

/** Creation is a single attempt; this client never retries it. */
export const createLiveSessionRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        id: Type.Optional(liveIdSchema),
        agentId: liveIdSchema,
        sdp: Type.String({ minLength: 1, maxLength: 65_536, pattern: "\\S" }),
        credential: liveCredentialRequestSchema,
        watchedAgentIds: Type.Optional(liveWatchedAgentIdsSchema),
    },
    { additionalProperties: false },
);
export type CreateLiveSessionRequest = Static<typeof createLiveSessionRequestSchema>;

/** SDP is returned only by creation, never by status reads or journal events. */
export const createLiveSessionResponseSchema = Type.Object({
    session: liveSessionSchema,
    transport: Type.Object({ type: Type.Literal("webrtc"), sdp: Type.String() }),
});
export type CreateLiveSessionResponse = Static<typeof createLiveSessionResponseSchema>;

export const liveSessionResponseSchema = Type.Object({ session: liveSessionSchema });
export type LiveSessionResponse = Static<typeof liveSessionResponseSchema>;

export const closeLiveSessionRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
export type CloseLiveSessionRequest = Static<typeof closeLiveSessionRequestSchema>;

export const liveSessionCreatedPayloadSchema = Type.Object({
    session: liveSessionSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type LiveSessionCreatedPayload = Static<typeof liveSessionCreatedPayloadSchema>;

export const liveSessionUpdatedChangesSchema = Type.Object({
    watchedAgentIds: Type.Optional(liveWatchedAgentIdsSchema),
    status: Type.Optional(liveSessionStatusSchema),
    usage: Type.Optional(liveSessionUsageSchema),
    error: Type.Optional(Nullable(Type.String())),
    endedAt: Type.Optional(Nullable(timestampSchema)),
    updatedAt: timestampSchema,
});
export type LiveSessionUpdatedChanges = Static<typeof liveSessionUpdatedChangesSchema>;

export const liveSessionUpdatedPayloadSchema = Type.Object({
    sessionId: liveIdSchema,
    previousVersion: resourceVersionSchema,
    version: resourceVersionSchema,
    changes: liveSessionUpdatedChangesSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type LiveSessionUpdatedPayload = Static<typeof liveSessionUpdatedPayloadSchema>;
