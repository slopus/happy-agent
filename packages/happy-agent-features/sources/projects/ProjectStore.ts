import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    projectAgentIdSchema,
    projectIdSchema,
    projectMutationOperationSchema,
    projectOperationFingerprintSchema,
    projectOperationIdSchema,
    projectRepositoryRefSchema,
    projectSchema,
    projectSettingsSchema,
    type Project,
} from "./Project.js";
import { projectContextSchema, projectEventSchema } from "./ProjectEvent.js";
import {
    projectPageQuerySchema,
    projectPageSchema,
    type ProjectPage,
    type ProjectPageQuery,
} from "./ProjectPage.js";

export const projectMutationRequestSchema = Type.Object(
    {
        operation: projectMutationOperationSchema,
        operationId: projectOperationIdSchema,
        fingerprint: projectOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

export const projectStoreCreateInputSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: Type.String({ minLength: 1, maxLength: 500 }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

/**
 * The store decides repository uniqueness inside its transaction. `id` is a
 * feature-supplied candidate used only if a new row is needed.
 */
export const projectStoreEnsureInputSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

export const projectStoreRenameInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);

export const projectStoreArchiveInputSchema = Type.Object(
    { projectId: projectIdSchema },
    { additionalProperties: false },
);

export const projectStoreSettingsUpdateInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

const projectMutationEnvelope = {
    agentId: projectAgentIdSchema,
    operationId: projectOperationIdSchema,
    fingerprint: projectOperationFingerprintSchema,
    changed: Type.Boolean(),
} as const;

export const projectCreateResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("create"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectEnsureResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("ensure"),
        created: Type.Boolean(),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectRenameResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("rename"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectArchiveResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("archive"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("update_settings"),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export const projectStoreMutationResultSchema = Type.Union([
    projectCreateResultSchema,
    projectEnsureResultSchema,
    projectRenameResultSchema,
    projectArchiveResultSchema,
    projectSettingsUpdateResultSchema,
]);

/**
 * Receipts carry replay data. Proofs independently bind the historical
 * before/after state, so a mutable receipt cannot manufacture a changed flag.
 */
export const projectOperationReceiptSchema = Type.Object(
    {
        agentId: projectAgentIdSchema,
        operation: projectMutationOperationSchema,
        operationId: projectOperationIdSchema,
        fingerprint: projectOperationFingerprintSchema,
        result: projectStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

export const projectMutationProofSchema = Type.Object(
    {
        agentId: projectAgentIdSchema,
        operation: projectMutationOperationSchema,
        operationId: projectOperationIdSchema,
        fingerprint: projectOperationFingerprintSchema,
        subjectId: projectIdSchema,
        before: Type.Union([projectSchema, Type.Null()]),
        after: Type.Union([projectSchema, Type.Null()]),
        settingsBefore: Type.Optional(Type.Union([projectSettingsSchema, Type.Null()])),
        settingsAfter: Type.Optional(Type.Union([projectSettingsSchema, Type.Null()])),
        changed: Type.Boolean(),
        result: projectStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

export const projectTransactionChangeSchema = Type.Object(
    {
        result: projectStoreMutationResultSchema,
        event: Type.Optional(projectEventSchema),
    },
    { additionalProperties: false },
);

const projectTransactionWorkSchema = Type.Function(
    [projectContextSchema],
    Type.Promise(projectTransactionChangeSchema),
);
const projectAfterCommitCallbackSchema = Type.Function(
    [projectContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const projectAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("ensure"),
    Type.Literal("create"),
    Type.Literal("rename"),
    Type.Literal("archive"),
    Type.Literal("settings_read"),
    Type.Literal("settings_update"),
]);

export const projectAuthorizationSchema = Type.Function(
    [
        projectContextSchema,
        projectAgentIdSchema,
        projectAgentIdSchema,
        projectAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

const projectReceiptResultSchema = Type.Union([projectOperationReceiptSchema, Type.Undefined()]);
const projectProofResultSchema = Type.Union([projectMutationProofSchema, Type.Undefined()]);

/**
 * The host owns persistence, filtering, transaction nesting, and the
 * outermost-commit boundary. Every callable is required and returns the
 * bounded structural value documented by its TypeBox schema.
 */
export const projectStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectTransactionWorkSchema],
            Type.Promise(projectTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectAfterCommitCallbackSchema],
            Type.Void(),
        ),
        create: Type.Function(
            [
                projectContextSchema,
                projectAgentIdSchema,
                projectStoreCreateInputSchema,
                projectMutationRequestSchema,
            ],
            Type.Promise(projectCreateResultSchema),
        ),
        ensure: Type.Function(
            [
                projectContextSchema,
                projectAgentIdSchema,
                projectStoreEnsureInputSchema,
                projectMutationRequestSchema,
            ],
            Type.Promise(projectEnsureResultSchema),
        ),
        list: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectPageQuerySchema],
            Type.Promise(projectPageSchema),
        ),
        get: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectIdSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        findByRepositoryRef: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectRepositoryRefSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        rename: Type.Function(
            [
                projectContextSchema,
                projectAgentIdSchema,
                projectStoreRenameInputSchema,
                projectMutationRequestSchema,
            ],
            Type.Promise(projectRenameResultSchema),
        ),
        archive: Type.Function(
            [
                projectContextSchema,
                projectAgentIdSchema,
                projectStoreArchiveInputSchema,
                projectMutationRequestSchema,
            ],
            Type.Promise(projectArchiveResultSchema),
        ),
        readSettings: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectIdSchema],
            Type.Promise(projectSettingsSchema),
        ),
        updateSettings: Type.Function(
            [
                projectContextSchema,
                projectAgentIdSchema,
                projectStoreSettingsUpdateInputSchema,
                projectMutationRequestSchema,
            ],
            Type.Promise(projectSettingsUpdateResultSchema),
        ),
        readReceipt: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectOperationIdSchema],
            Type.Promise(projectReceiptResultSchema),
        ),
        writeReceipt: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectOperationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectOperationIdSchema],
            Type.Promise(projectProofResultSchema),
        ),
        writeMutationProof: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectMutationProofSchema],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

export type ProjectStore = Static<typeof projectStoreSchema>;
export type ProjectStoreCreateInput = Static<typeof projectStoreCreateInputSchema>;
export type ProjectStoreEnsureInput = Static<typeof projectStoreEnsureInputSchema>;
export type ProjectStoreRenameInput = Static<typeof projectStoreRenameInputSchema>;
export type ProjectStoreArchiveInput = Static<typeof projectStoreArchiveInputSchema>;
export type ProjectStoreSettingsUpdateInput = Static<typeof projectStoreSettingsUpdateInputSchema>;
export type ProjectMutationRequest = Static<typeof projectMutationRequestSchema>;
export type ProjectCreateResult = Static<typeof projectCreateResultSchema>;
export type ProjectEnsureResult = Static<typeof projectEnsureResultSchema>;
export type ProjectRenameResult = Static<typeof projectRenameResultSchema>;
export type ProjectArchiveResult = Static<typeof projectArchiveResultSchema>;
export type ProjectSettingsUpdateResult = Static<typeof projectSettingsUpdateResultSchema>;
export type ProjectStoreMutationResult = Static<typeof projectStoreMutationResultSchema>;
export type ProjectOperationReceipt = Static<typeof projectOperationReceiptSchema>;
export type ProjectMutationProof = Static<typeof projectMutationProofSchema>;
export type ProjectTransactionChange = Static<typeof projectTransactionChangeSchema>;
export type ProjectAuthorizationAction = Static<typeof projectAuthorizationActionSchema>;
export type ProjectAuthorization = Static<typeof projectAuthorizationSchema>;

export type { Project, ProjectPage, ProjectPageQuery };

export function assertProjectStore(value: unknown): asserts value is ProjectStore {
    if (!Value.Check(projectStoreSchema, value)) {
        throw new Error("Project feature received an invalid host store.");
    }
}

export function assertProject(value: unknown): asserts value is Project {
    if (!Value.Check(projectSchema, value)) {
        throw new Error("Project store returned an invalid project.");
    }
}

export function assertProjectPage(value: unknown): asserts value is ProjectPage {
    if (!Value.Check(projectPageSchema, value)) {
        throw new Error("Project store returned an invalid project page.");
    }
}

export function assertProjectCreateResult(value: unknown): asserts value is ProjectCreateResult {
    if (!Value.Check(projectCreateResultSchema, value)) {
        throw new Error("Project store returned an invalid create result.");
    }
}

export function assertProjectEnsureResult(value: unknown): asserts value is ProjectEnsureResult {
    if (!Value.Check(projectEnsureResultSchema, value)) {
        throw new Error("Project store returned an invalid ensure result.");
    }
}

export function assertProjectRenameResult(value: unknown): asserts value is ProjectRenameResult {
    if (!Value.Check(projectRenameResultSchema, value)) {
        throw new Error("Project store returned an invalid rename result.");
    }
}

export function assertProjectArchiveResult(value: unknown): asserts value is ProjectArchiveResult {
    if (!Value.Check(projectArchiveResultSchema, value)) {
        throw new Error("Project store returned an invalid archive result.");
    }
}

export function assertProjectSettingsUpdateResult(
    value: unknown,
): asserts value is ProjectSettingsUpdateResult {
    if (!Value.Check(projectSettingsUpdateResultSchema, value)) {
        throw new Error("Project store returned an invalid settings result.");
    }
}

export function assertProjectStoreMutationResult(
    value: unknown,
): asserts value is ProjectStoreMutationResult {
    if (!Value.Check(projectStoreMutationResultSchema, value)) {
        throw new Error("Project store returned an invalid mutation result.");
    }
}

export function assertProjectOperationReceipt(
    value: unknown,
): asserts value is ProjectOperationReceipt {
    if (!Value.Check(projectOperationReceiptSchema, value)) {
        throw new Error("Project store returned an invalid operation receipt.");
    }
}

export function assertProjectMutationProof(value: unknown): asserts value is ProjectMutationProof {
    if (!Value.Check(projectMutationProofSchema, value)) {
        throw new Error("Project store returned an invalid immutable proof.");
    }
}

export function assertProjectTransactionChange(
    value: unknown,
): asserts value is ProjectTransactionChange {
    if (!Value.Check(projectTransactionChangeSchema, value)) {
        throw new Error("Project store returned an invalid transaction change.");
    }
}
