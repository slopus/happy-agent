import { Type, type Static } from "@sinclair/typebox";
import { agentConfigSchema } from "@slopus/happy-agent-base";

/** The largest timestamp accepted by collaboration persistence and host scheduling. */
export const COLLABORATION_MAX_TIMESTAMP = 8_640_000_000_000_000;

/** IDs used by the collaboration roster and by Agent Base. */
export const collaborationAgentIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

/** An operation identity retained by a host receipt. */
export const collaborationOperationIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

/** A canonical request fingerprint retained by a host receipt. */
export const collaborationFingerprintSchema = Type.String({
    minLength: 1,
    maxLength: 65_536,
});

/** Limits apply at every metadata level, and the encoded limit is checked semantically. */
export const COLLABORATION_METADATA_MAX_DEPTH = 8;
export const COLLABORATION_METADATA_MAX_STRING_LENGTH = 4_096;
export const COLLABORATION_METADATA_MAX_KEY_LENGTH = 128;
export const COLLABORATION_METADATA_MAX_ITEMS = 64;
export const COLLABORATION_METADATA_MAX_PROPERTIES = 64;
export const COLLABORATION_METADATA_MAX_ENCODED_BYTES = 16_384;

/** A JSON value accepted in agent, message, and protocol metadata. */
export const collaborationMetadataValueSchema = Type.Recursive((value) =>
    Type.Union([
        Type.String({ maxLength: COLLABORATION_METADATA_MAX_STRING_LENGTH }),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
        Type.Array(value, { maxItems: COLLABORATION_METADATA_MAX_ITEMS }),
        Type.Record(Type.String({ maxLength: COLLABORATION_METADATA_MAX_KEY_LENGTH }), value, {
            maxProperties: COLLABORATION_METADATA_MAX_PROPERTIES,
        }),
    ]),
);

export const collaborationMetadataSchema = Type.Record(
    Type.String({ maxLength: COLLABORATION_METADATA_MAX_KEY_LENGTH }),
    collaborationMetadataValueSchema,
    { maxProperties: COLLABORATION_METADATA_MAX_PROPERTIES },
);

/** A small, host-defined role for an agent in a collaboration. */
export const collaborationRoleSchema = Type.String({
    minLength: 1,
    maxLength: 128,
});

/** Durable lifecycle state owned by the host roster. Agents are never deleted by this feature. */
export const collaborationAgentStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("idle"),
    Type.Literal("waiting"),
]);

/**
 * Durable host-owned roster row for one Agent Base identity.
 *
 * `ownerAgentId` is the caller that created or controls the row. A root row owns itself;
 * descendants normally use their creating agent as owner. A host authorization policy may grant
 * additional access without changing this durable ownership.
 */
export const collaborationAgentSchema = Type.Object(
    {
        id: collaborationAgentIdSchema,
        ownerAgentId: collaborationAgentIdSchema,
        parentId: Type.Union([collaborationAgentIdSchema, Type.Null()]),
        role: Type.Optional(collaborationRoleSchema),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        metadata: Type.Optional(collaborationMetadataSchema),
        status: collaborationAgentStatusSchema,
        createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        updatedAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    },
    { additionalProperties: false },
);

/** Input for host or tool-created collaborators. The feature assigns omitted IDs. */
export const collaborationCreateInputSchema = Type.Object(
    {
        operationId: Type.Optional(collaborationOperationIdSchema),
        id: Type.Optional(collaborationAgentIdSchema),
        config: agentConfigSchema,
        parentId: Type.Optional(Type.Union([collaborationAgentIdSchema, Type.Null()])),
        role: Type.Optional(collaborationRoleSchema),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        metadata: Type.Optional(collaborationMetadataSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; durable roster and Agent Base identities are feature-owned. */
export const collaborationCreateToolInputSchema = Type.Omit(collaborationCreateInputSchema, [
    "operationId",
    "id",
]);

/** A bounded roster query. Cursors are opaque to the feature and host. */
export const collaborationAgentPageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        ownerAgentId: Type.Optional(collaborationAgentIdSchema),
    },
    { additionalProperties: false },
);

export const collaborationAgentPageSchema = Type.Object(
    {
        agents: Type.Array(collaborationAgentSchema, { maxItems: 100 }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);

export type CollaborationAgentId = Static<typeof collaborationAgentIdSchema>;
export type CollaborationOperationId = Static<typeof collaborationOperationIdSchema>;
export type CollaborationFingerprint = Static<typeof collaborationFingerprintSchema>;
export type CollaborationRole = Static<typeof collaborationRoleSchema>;
export type CollaborationAgentStatus = Static<typeof collaborationAgentStatusSchema>;
export type CollaborationMetadataValue = Static<typeof collaborationMetadataValueSchema>;
export type CollaborationMetadata = Static<typeof collaborationMetadataSchema>;
export type CollaborationAgent = Static<typeof collaborationAgentSchema>;
export type CollaborationCreateInput = Static<typeof collaborationCreateInputSchema>;
export type CollaborationCreateToolInput = Static<typeof collaborationCreateToolInputSchema>;
export type CollaborationAgentPageQuery = Static<typeof collaborationAgentPageQuerySchema>;
export type CollaborationAgentPage = Static<typeof collaborationAgentPageSchema>;
