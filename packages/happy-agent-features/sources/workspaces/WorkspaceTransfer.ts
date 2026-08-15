import { Type, type Static } from "@sinclair/typebox";

import {
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceOperationFingerprintSchema,
    workspaceOperationIdSchema,
    workspaceProjectRefSchema,
    workspaceSchema,
} from "./Workspace.js";

/**
 * Transfer the current session into another existing workspace. The host owns
 * snapshot, checkout, and filesystem behavior.
 */
export const workspaceSessionTransferInputSchema = Type.Object(
    {
        targetWorkspaceId: workspaceIdSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

/**
 * Transfer an explicitly identified owned workspace to another opaque project
 * reference. This keeps the facade useful to host callers that operate on
 * catalog rows directly.
 */
export const workspaceProjectTransferInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        targetProjectRef: workspaceProjectRefSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceTransferInputSchema = Type.Union([
    workspaceSessionTransferInputSchema,
    workspaceProjectTransferInputSchema,
]);

export const workspaceSessionTransferToolInputSchema = Type.Object(
    { targetWorkspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

/** Compact transfer record used when the host has not returned a full row. */
export const workspaceTransferWorkspaceSchema = Type.Object(
    {
        id: workspaceIdSchema,
        projectRef: workspaceProjectRefSchema,
        ownerAgentId: Type.Optional(workspaceAgentIdSchema),
    },
    { additionalProperties: false },
);

const transferEnvelope = {
    agentId: workspaceAgentIdSchema,
    operationId: workspaceOperationIdSchema,
    fingerprint: workspaceOperationFingerprintSchema,
    changed: Type.Boolean(),
} as const;

export const workspaceTransferResultSchema = Type.Union([
    Type.Object(
        {
            ...transferEnvelope,
            state: Type.Literal("scheduled"),
            targetWorkspaceId: workspaceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...transferEnvelope,
            state: Type.Literal("transferred"),
            targetWorkspaceId: Type.Optional(workspaceIdSchema),
            workspace: workspaceTransferWorkspaceSchema,
        },
        { additionalProperties: false },
    ),
]);

/**
 * Some host adapters return the complete target row. The feature accepts that
 * shape only as an adapter result and normalizes it to the compact public
 * envelope after reconciliation.
 */
export const workspaceTransferStoreResultSchema = Type.Union([
    workspaceTransferResultSchema,
    workspaceSchema,
]);

export type WorkspaceSessionTransferInput = Static<typeof workspaceSessionTransferInputSchema>;
export type WorkspaceProjectTransferInput = Static<typeof workspaceProjectTransferInputSchema>;
export type WorkspaceTransferInput = Static<typeof workspaceTransferInputSchema>;
export type WorkspaceTransferWorkspace = Static<typeof workspaceTransferWorkspaceSchema>;
export type WorkspaceTransferResult = Static<typeof workspaceTransferResultSchema>;
export type WorkspaceTransferStoreResult = Static<typeof workspaceTransferStoreResultSchema>;
