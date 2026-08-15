import { Type, type Static } from "@sinclair/typebox";

/**
 * Workspaces are host-owned records. The feature only validates and forwards
 * their opaque references; it never interprets a path, branch, or Git value.
 */
export const MAX_WORKSPACE_ID_LENGTH = 96;
export const MAX_WORKSPACE_AGENT_ID_LENGTH = 96;
export const MAX_WORKSPACE_OPERATION_ID_LENGTH = 96;
export const MAX_WORKSPACE_PROJECT_REF_LENGTH = 256;
export const MAX_WORKSPACE_NAME_LENGTH = 500;
export const MAX_WORKSPACE_BASE_REF_LENGTH = 1_024;
export const MAX_WORKSPACE_FINGERPRINT_LENGTH = 64;
export const MAX_WORKSPACE_EVENT_ID_LENGTH = 128;
export const MAX_WORKSPACE_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export const workspaceIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_ID_LENGTH,
});

export const workspaceAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_AGENT_ID_LENGTH,
});

export const workspaceOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_OPERATION_ID_LENGTH,
});

/** A SHA-256 digest of one normalized operation request. */
export const workspaceOperationFingerprintSchema = Type.String({
    minLength: MAX_WORKSPACE_FINGERPRINT_LENGTH,
    maxLength: MAX_WORKSPACE_FINGERPRINT_LENGTH,
    pattern: "^[0-9a-f]{64}$",
});

/** An opaque host-owned reference to a project. */
export const workspaceProjectRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PROJECT_REF_LENGTH,
});

export const workspaceNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_NAME_LENGTH,
});

export const workspaceBaseRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_BASE_REF_LENGTH,
});

export const workspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("active"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);

export const workspaceTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_TIMESTAMP,
});

export const workspaceMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("transfer"),
    Type.Literal("archive"),
]);

/**
 * Durable identities are allocated by the feature for a single durable tool
 * call. The fingerprint prevents a reused call scope from silently becoming a
 * different mutation.
 */
export const workspaceOperationStateSchema = Type.Object(
    {
        id: Type.Union([workspaceIdSchema, workspaceOperationIdSchema]),
        fingerprint: workspaceOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

/**
 * Public workspace data. `ownerAgentId` is deliberately part of the record:
 * the feature cannot enforce exact ownership if a host can omit it.
 */
export const workspaceSchema = Type.Object(
    {
        id: workspaceIdSchema,
        ownerAgentId: workspaceAgentIdSchema,
        projectRef: workspaceProjectRefSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
        name: workspaceNameSchema,
        status: workspaceStatusSchema,
        createdAt: workspaceTimestampSchema,
        updatedAt: workspaceTimestampSchema,
        archivedAt: Type.Optional(workspaceTimestampSchema),
    },
    { additionalProperties: false },
);

/**
 * Public creation input. A host caller supplies `operationId`; the durable
 * tools intentionally omit it and let the feature allocate it from their
 * call-scoped AgentKV.
 */
export const workspaceCreateInputSchema = Type.Object(
    {
        id: Type.Optional(workspaceIdSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
        projectRef: Type.Optional(workspaceProjectRefSchema),
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; persistence identities remain feature-owned. */
export const workspaceCreateToolInputSchema = Type.Object(
    {
        projectRef: Type.Optional(workspaceProjectRefSchema),
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);

export const workspaceArchiveOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceId = Static<typeof workspaceIdSchema>;
export type WorkspaceAgentId = Static<typeof workspaceAgentIdSchema>;
export type WorkspaceOperationId = Static<typeof workspaceOperationIdSchema>;
export type WorkspaceOperationFingerprint = Static<typeof workspaceOperationFingerprintSchema>;
export type WorkspaceProjectRef = Static<typeof workspaceProjectRefSchema>;
export type WorkspaceName = Static<typeof workspaceNameSchema>;
export type WorkspaceBaseRef = Static<typeof workspaceBaseRefSchema>;
export type WorkspaceStatus = Static<typeof workspaceStatusSchema>;
export type WorkspaceMutationOperation = Static<typeof workspaceMutationOperationSchema>;
export type WorkspaceOperationState = Static<typeof workspaceOperationStateSchema>;
export type Workspace = Static<typeof workspaceSchema>;
export type WorkspaceCreateInput = Static<typeof workspaceCreateInputSchema>;
export type WorkspaceCreateToolInput = Static<typeof workspaceCreateToolInputSchema>;
export type WorkspaceArchiveOptions = Static<typeof workspaceArchiveOptionsSchema>;
