import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    projectAvatarAssetSchema,
    projectAvatarSchema,
    projectDescriptionSchema,
    projectErrorSchema,
    projectGitDivergenceSchema,
    projectGitRefSchema,
    projectIdSchema,
    projectInitializationAttemptSchema,
    projectInitializationStatusSchema,
    projectKindSchema,
    projectNameSchema,
    projectNameSourceSchema,
    projectOrderKeySchema,
    projectPresenceSchema,
    projectRemoteSourceSchema,
    projectRepositoryRefSchema,
    projectRequiredSecretKindSchema,
    projectSchema,
    projectVersionSchema,
    projectWorkspaceSetupCommandsSchema,
    projectWorktreeSupportSchema,
    type Project,
    projectRunnerIdSchema,
} from "./Project.js";
import { projectContextSchema } from "./ProjectEvent.js";
import {
    projectPageQuerySchema,
    projectPageSchema,
    type ProjectPage,
    type ProjectPageQuery,
} from "./ProjectPage.js";
import { projectSettingsSchema } from "./ProjectSettings.js";
import { createProjectCatalogEdits } from "./store/projectCatalogEdits.js";
import { createProjectLifecycle } from "./store/projectLifecycle.js";
import { createProjectQueries } from "./store/projectQueries.js";
import { createProjectRegistration } from "./store/projectRegistration.js";

export const projectStoreCreateInputSchema = Type.Object(
    {
        description: Type.Optional(projectDescriptionSchema),
        id: projectIdSchema,
        kind: projectKindSchema,
        name: projectNameSchema,
        nameSource: projectNameSourceSchema,
        remoteSource: Type.Optional(projectRemoteSourceSchema),
        repositoryRef: projectRepositoryRefSchema,
        requiredSecretKind: Type.Optional(projectRequiredSecretKindSchema),
        runnerId: Type.Optional(projectRunnerIdSchema),
    },
    { additionalProperties: false },
);

/**
 * The store decides folder uniqueness inside its transaction. `id` is a
 * module-supplied candidate used only if a new row is needed.
 */
export const projectStoreEnsureInputSchema = projectStoreCreateInputSchema;

export const projectStoreRenameInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

export const projectStoreArchiveInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreRestoreInputSchema = Type.Object(
    { projectId: projectIdSchema },
    { additionalProperties: false },
);

export const projectStoreReorderInputSchema = Type.Object(
    {
        afterId: Type.Union([projectIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreSetAvatarInputSchema = Type.Object(
    {
        asset: projectAvatarAssetSchema,
        avatar: projectAvatarSchema,
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreClearAvatarInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreSettingsUpdateInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

/**
 * Host-reported state. Every field is optional and a null clears the column,
 * so one write covers probes, Git facts and the initialization transitions.
 */
export const projectStateChangesSchema = Type.Object(
    {
        defaultBranch: Type.Optional(projectGitRefSchema),
        gitAhead: Type.Optional(projectGitDivergenceSchema),
        gitBehind: Type.Optional(projectGitDivergenceSchema),
        gitBranch: Type.Optional(Type.Union([projectGitRefSchema, Type.Null()])),
        gitDetached: Type.Optional(Type.Boolean()),
        gitHead: Type.Optional(Type.Union([projectGitRefSchema, Type.Null()])),
        gitUpstream: Type.Optional(Type.Union([projectGitRefSchema, Type.Null()])),
        initializationAttempt: Type.Optional(projectInitializationAttemptSchema),
        initializationError: Type.Optional(Type.Union([projectErrorSchema, Type.Null()])),
        initializationStatus: Type.Optional(projectInitializationStatusSchema),
        name: Type.Optional(projectNameSchema),
        nameSource: Type.Optional(projectNameSourceSchema),
        presence: Type.Optional(projectPresenceSchema),
        worktreeSupport: Type.Optional(projectWorktreeSupportSchema),
        worktreeUnsupportedReason: Type.Optional(Type.Union([projectErrorSchema, Type.Null()])),
        workspaceSetupCommands: Type.Optional(projectWorkspaceSetupCommandsSchema),
    },
    { additionalProperties: false },
);

export const projectStoreStateChangeInputSchema = Type.Object(
    {
        changes: projectStateChangesSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

const projectMutationEnvelope = {
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

export const projectRestoreResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("restore"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectReorderResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("reorder"),
        previousOrderKey: projectOrderKeySchema,
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectSetAvatarResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("set_avatar"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectClearAvatarResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("clear_avatar"),
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
        version: projectVersionSchema,
    },
    { additionalProperties: false },
);

export const projectStateChangeResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("state_change"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectStoreMutationResultSchema = Type.Union([
    projectCreateResultSchema,
    projectEnsureResultSchema,
    projectRenameResultSchema,
    projectArchiveResultSchema,
    projectRestoreResultSchema,
    projectReorderResultSchema,
    projectSetAvatarResultSchema,
    projectClearAvatarResultSchema,
    projectSettingsUpdateResultSchema,
    projectStateChangeResultSchema,
]);

/**
 * This is the private persistence contract used by the module-owned SQLite
 * adapter below. It remains exported for the protocol package's structural
 * types, but callers never inject a store into ProjectsModule.
 */
export const projectStoreSchema = Type.Object(
    {
        create: Type.Function(
            [projectContextSchema, projectStoreCreateInputSchema],
            Type.Promise(projectCreateResultSchema),
        ),
        ensure: Type.Function(
            [projectContextSchema, projectStoreEnsureInputSchema],
            Type.Promise(projectEnsureResultSchema),
        ),
        list: Type.Function(
            [projectContextSchema, projectPageQuerySchema],
            Type.Promise(projectPageSchema),
        ),
        get: Type.Function(
            [projectContextSchema, projectIdSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        findByPath: Type.Function(
            [
                projectContextSchema,
                projectRepositoryRefSchema,
                Type.Union([projectRunnerIdSchema, Type.Undefined()]),
            ],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        readAvatar: Type.Function(
            [projectContextSchema, projectIdSchema],
            Type.Promise(Type.Union([projectAvatarAssetSchema, Type.Undefined()])),
        ),
        rename: Type.Function(
            [projectContextSchema, projectStoreRenameInputSchema],
            Type.Promise(projectRenameResultSchema),
        ),
        archive: Type.Function(
            [projectContextSchema, projectStoreArchiveInputSchema],
            Type.Promise(projectArchiveResultSchema),
        ),
        restore: Type.Function(
            [projectContextSchema, projectStoreRestoreInputSchema],
            Type.Promise(projectRestoreResultSchema),
        ),
        reorder: Type.Function(
            [projectContextSchema, projectStoreReorderInputSchema],
            Type.Promise(projectReorderResultSchema),
        ),
        setAvatar: Type.Function(
            [projectContextSchema, projectStoreSetAvatarInputSchema],
            Type.Promise(projectSetAvatarResultSchema),
        ),
        clearAvatar: Type.Function(
            [projectContextSchema, projectStoreClearAvatarInputSchema],
            Type.Promise(projectClearAvatarResultSchema),
        ),
        readSettings: Type.Function(
            [projectContextSchema, projectIdSchema],
            Type.Promise(projectSettingsSchema),
        ),
        updateSettings: Type.Function(
            [projectContextSchema, projectStoreSettingsUpdateInputSchema],
            Type.Promise(projectSettingsUpdateResultSchema),
        ),
        applyState: Type.Function(
            [projectContextSchema, projectStoreStateChangeInputSchema],
            Type.Promise(projectStateChangeResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type ProjectStore = Static<typeof projectStoreSchema>;
export type ProjectStoreCreateInput = Static<typeof projectStoreCreateInputSchema>;
export type ProjectStoreEnsureInput = Static<typeof projectStoreEnsureInputSchema>;
export type ProjectStoreRenameInput = Static<typeof projectStoreRenameInputSchema>;
export type ProjectStoreArchiveInput = Static<typeof projectStoreArchiveInputSchema>;
export type ProjectStoreRestoreInput = Static<typeof projectStoreRestoreInputSchema>;
export type ProjectStoreReorderInput = Static<typeof projectStoreReorderInputSchema>;
export type ProjectStoreSetAvatarInput = Static<typeof projectStoreSetAvatarInputSchema>;
export type ProjectStoreClearAvatarInput = Static<typeof projectStoreClearAvatarInputSchema>;
export type ProjectStoreSettingsUpdateInput = Static<typeof projectStoreSettingsUpdateInputSchema>;
export type ProjectStoreStateChangeInput = Static<typeof projectStoreStateChangeInputSchema>;
export type ProjectStateChanges = Static<typeof projectStateChangesSchema>;
export type ProjectCreateResult = Static<typeof projectCreateResultSchema>;
export type ProjectEnsureResult = Static<typeof projectEnsureResultSchema>;
export type ProjectRenameResult = Static<typeof projectRenameResultSchema>;
export type ProjectArchiveResult = Static<typeof projectArchiveResultSchema>;
export type ProjectRestoreResult = Static<typeof projectRestoreResultSchema>;
export type ProjectReorderResult = Static<typeof projectReorderResultSchema>;
export type ProjectSetAvatarResult = Static<typeof projectSetAvatarResultSchema>;
export type ProjectClearAvatarResult = Static<typeof projectClearAvatarResultSchema>;
export type ProjectSettingsUpdateResult = Static<typeof projectSettingsUpdateResultSchema>;
export type ProjectStateChangeResult = Static<typeof projectStateChangeResultSchema>;
export type ProjectStoreMutationResult = Static<typeof projectStoreMutationResultSchema>;

export type { Project, ProjectPage, ProjectPageQuery };

export function assertProjectStore(value: unknown): asserts value is ProjectStore {
    if (!Value.Check(projectStoreSchema, value)) {
        throw new Error("Project module received an invalid host store.");
    }
}

export function assertProjectPage(value: unknown): asserts value is ProjectPage {
    if (!Value.Check(projectPageSchema, value)) {
        throw new Error("Project store returned an invalid project page.");
    }
}

export function assertProjectStoreMutationResult(
    value: unknown,
): asserts value is ProjectStoreMutationResult {
    if (!Value.Check(projectStoreMutationResultSchema, value)) {
        throw new Error("Project store returned an invalid mutation result.");
    }
}

export function createProjectStore(): ProjectStore {
    return {
        ...createProjectQueries(),
        ...createProjectRegistration(),
        ...createProjectLifecycle(),
        ...createProjectCatalogEdits(),
    };
}
