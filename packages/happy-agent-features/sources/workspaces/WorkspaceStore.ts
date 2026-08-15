import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceMutationOperationSchema,
    workspaceOperationFingerprintSchema,
    workspaceOperationIdSchema,
    workspaceProjectRefSchema,
    workspaceSchema,
    type Workspace,
} from "./Workspace.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import { workspaceContextSchema, workspaceEventSchema } from "./WorkspaceEvent.js";
import {
    workspacePageQuerySchema,
    workspacePageSchema,
    workspaceListSchema,
    type WorkspacePage,
    type WorkspacePageQuery,
    type WorkspaceList,
} from "./WorkspacePage.js";
import {
    workspaceTransferInputSchema,
    workspaceTransferResultSchema,
    workspaceTransferStoreResultSchema,
    type WorkspaceTransferInput,
    type WorkspaceTransferResult,
    type WorkspaceTransferStoreResult,
} from "./WorkspaceTransfer.js";

export const workspaceMutationRequestSchema = Type.Object(
    {
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
        fingerprint: workspaceOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

/**
 * The feature adds `ownerAgentId` before crossing the host boundary. The
 * project reference remains optional because a host may resolve a default
 * project while creating the row.
 */
export const workspaceStoreCreateInputSchema = Type.Object(
    {
        id: workspaceIdSchema,
        ownerAgentId: workspaceAgentIdSchema,
        projectRef: Type.Optional(workspaceProjectRefSchema),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    },
    { additionalProperties: false },
);

export const workspaceStoreArchiveInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

const workspaceMutationEnvelope = {
    agentId: workspaceAgentIdSchema,
    operationId: workspaceOperationIdSchema,
    fingerprint: workspaceOperationFingerprintSchema,
    changed: Type.Boolean(),
} as const;

export const workspaceCreateResultSchema = Type.Object(
    {
        ...workspaceMutationEnvelope,
        operation: Type.Literal("create"),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceArchiveResultSchema = Type.Object(
    {
        ...workspaceMutationEnvelope,
        operation: Type.Literal("archive"),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceStoreMutationResultSchema = Type.Union([
    workspaceCreateResultSchema,
    workspaceArchiveResultSchema,
    workspaceTransferResultSchema,
]);

/**
 * An immutable proof binds historical before/after state and the exact result
 * that was returned. Receipts alone are mutable replay data and cannot prove
 * a later `changed` decision.
 */
export const workspaceMutationProofSchema = Type.Object(
    {
        agentId: workspaceAgentIdSchema,
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
        fingerprint: workspaceOperationFingerprintSchema,
        subjectId: workspaceIdSchema,
        before: Type.Union([workspaceSchema, Type.Null()]),
        after: Type.Union([workspaceSchema, Type.Null()]),
        changed: Type.Boolean(),
        result: workspaceStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

export const workspaceOperationReceiptSchema = Type.Object(
    {
        agentId: workspaceAgentIdSchema,
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
        fingerprint: workspaceOperationFingerprintSchema,
        result: workspaceStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

export const workspaceTransactionChangeSchema = Type.Object(
    {
        result: workspaceStoreMutationResultSchema,
        event: Type.Optional(workspaceEventSchema),
    },
    { additionalProperties: false },
);

const workspaceTransactionWorkSchema = Type.Function(
    [workspaceContextSchema],
    Type.Promise(workspaceTransactionChangeSchema),
);
const workspaceAfterCommitCallbackSchema = Type.Function(
    [workspaceContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const workspaceMutationProofResultSchema = Type.Union([
    workspaceMutationProofSchema,
    Type.Undefined(),
]);
const workspaceReceiptResultSchema = Type.Union([
    workspaceOperationReceiptSchema,
    Type.Undefined(),
]);

export const workspaceAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("branch_metadata"),
    Type.Literal("transfer"),
]);

/**
 * Missing authorization is an intentional deny for another owner's record.
 * Self access is granted by the feature without invoking this policy.
 */
export const workspaceAuthorizationSchema = Type.Function(
    [
        workspaceContextSchema,
        workspaceAgentIdSchema,
        workspaceAgentIdSchema,
        workspaceAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

export type WorkspaceAuthorizationAction = Static<typeof workspaceAuthorizationActionSchema>;
export type WorkspaceAuthorization = Static<typeof workspaceAuthorizationSchema>;

/**
 * Every callback includes the acting agent. The host owns filtering,
 * serialization, transaction nesting, receipt/proof persistence, and the
 * outermost commit boundary.
 */
export const workspaceStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceTransactionWorkSchema],
            Type.Promise(workspaceTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceAfterCommitCallbackSchema],
            Type.Void(),
        ),
        create: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreCreateInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceCreateResultSchema),
        ),
        list: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspacePageQuerySchema],
            Type.Promise(workspacePageSchema),
        ),
        get: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        transfer: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceTransferInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceTransferStoreResultSchema),
        ),
        archive: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreArchiveInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceArchiveResultSchema),
        ),
        branchMetadata: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(workspaceBranchMetadataSchema),
        ),
        readReceipt: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceOperationIdSchema],
            Type.Promise(workspaceReceiptResultSchema),
        ),
        writeReceipt: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceOperationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceOperationIdSchema],
            Type.Promise(workspaceMutationProofResultSchema),
        ),
        writeMutationProof: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceMutationProofSchema],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceStore = Static<typeof workspaceStoreSchema>;
export type WorkspaceStoreCreateInput = Static<typeof workspaceStoreCreateInputSchema>;
export type WorkspaceStoreArchiveInput = Static<typeof workspaceStoreArchiveInputSchema>;
export type WorkspaceMutationRequest = Static<typeof workspaceMutationRequestSchema>;
export type WorkspaceCreateResult = Static<typeof workspaceCreateResultSchema>;
export type WorkspaceArchiveResult = Static<typeof workspaceArchiveResultSchema>;
export type WorkspaceStoreMutationResult = Static<typeof workspaceStoreMutationResultSchema>;
export type WorkspaceMutationProof = Static<typeof workspaceMutationProofSchema>;
export type WorkspaceOperationReceipt = Static<typeof workspaceOperationReceiptSchema>;
export type WorkspaceTransactionChange = Static<typeof workspaceTransactionChangeSchema>;

export type {
    Workspace,
    WorkspaceBranchMetadata,
    WorkspacePage,
    WorkspacePageQuery,
    WorkspaceTransferInput,
    WorkspaceTransferResult,
    WorkspaceTransferStoreResult,
};

export function assertWorkspaceStore(value: unknown): asserts value is WorkspaceStore {
    if (!Value.Check(workspaceStoreSchema, value)) {
        throw new Error("Workspace feature received an invalid host store.");
    }
}

export function assertWorkspace(value: unknown): asserts value is Workspace {
    if (!Value.Check(workspaceSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace.");
    }
}

export function assertWorkspacePage(value: unknown): asserts value is WorkspacePage {
    if (!Value.Check(workspacePageSchema, value)) {
        throw new Error("Workspace store returned an invalid page.");
    }
}

export function assertWorkspaceList(value: unknown): asserts value is WorkspaceList {
    if (!Value.Check(workspaceListSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace list.");
    }
}

export function assertWorkspaceBranchMetadata(
    value: unknown,
): asserts value is WorkspaceBranchMetadata {
    if (!Value.Check(workspaceBranchMetadataSchema, value)) {
        throw new Error("Workspace store returned invalid branch metadata.");
    }
}

export function assertWorkspaceCreateResult(
    value: unknown,
): asserts value is WorkspaceCreateResult {
    if (!Value.Check(workspaceCreateResultSchema, value)) {
        throw new Error("Workspace store returned an invalid create result.");
    }
}

export function assertWorkspaceArchiveResult(
    value: unknown,
): asserts value is WorkspaceArchiveResult {
    if (!Value.Check(workspaceArchiveResultSchema, value)) {
        throw new Error("Workspace store returned an invalid archive result.");
    }
}

export function assertWorkspaceStoreMutationResult(
    value: unknown,
): asserts value is WorkspaceStoreMutationResult {
    if (!Value.Check(workspaceStoreMutationResultSchema, value)) {
        throw new Error("Workspace store returned an invalid mutation result.");
    }
}

export function assertWorkspaceTransferResult(
    value: unknown,
): asserts value is WorkspaceTransferResult {
    if (!Value.Check(workspaceTransferResultSchema, value)) {
        throw new Error("Workspace store returned an invalid transfer result.");
    }
}

export function assertWorkspaceMutationProof(
    value: unknown,
): asserts value is WorkspaceMutationProof {
    if (!Value.Check(workspaceMutationProofSchema, value)) {
        throw new Error("Workspace store returned an invalid mutation proof.");
    }
}

export function assertWorkspaceOperationReceipt(
    value: unknown,
): asserts value is WorkspaceOperationReceipt {
    if (!Value.Check(workspaceOperationReceiptSchema, value)) {
        throw new Error("Workspace store returned an invalid operation receipt.");
    }
}

export function assertWorkspaceTransactionChange(
    value: unknown,
): asserts value is WorkspaceTransactionChange {
    if (!Value.Check(workspaceTransactionChangeSchema, value)) {
        throw new Error("Workspace store transaction returned an invalid change.");
    }
}
