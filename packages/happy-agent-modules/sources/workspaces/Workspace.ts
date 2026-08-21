import { Type, type Static } from "@sinclair/typebox";

/**
 * A workspace is a folder someone works in. When the project is a Git folder that folder is a
 * worktree, and the worktree is always a branch — the branch name is mandatory because other
 * software reads it. The module owns the durable record; Git and the filesystem stay with the host,
 * which reports what it actually did through the lifecycle operations below.
 */
export const MAX_WORKSPACE_ID_LENGTH = 96;
export const MAX_WORKSPACE_AGENT_ID_LENGTH = 96;
export const MAX_WORKSPACE_OPERATION_ID_LENGTH = 96;
export const MAX_WORKSPACE_SESSION_ID_LENGTH = 96;
export const MAX_WORKSPACE_PROJECT_REF_LENGTH = 256;
export const MAX_WORKSPACE_NAME_LENGTH = 500;
export const MAX_WORKSPACE_BASE_REF_LENGTH = 1_024;
export const MAX_WORKSPACE_BRANCH_LENGTH = 512;
export const MAX_WORKSPACE_STORAGE_KEY_LENGTH = 128;
export const MAX_WORKSPACE_ORDER_KEY_LENGTH = 64;
export const MAX_WORKSPACE_PATH_LENGTH = 4_096;
export const MAX_WORKSPACE_COMMIT_LENGTH = 64;
export const MAX_WORKSPACE_GIT_REF_LENGTH = 512;
export const MAX_WORKSPACE_DIVERGENCE = 1_000_000;
export const MAX_WORKSPACE_INITIALIZATION_ATTEMPT = 1_000_000;
/** Human-readable failure detail kept for one workspace, matching Happy Agent's durable error bound. */
export const MAX_WORKSPACE_ERROR_LENGTH = 500;
export const MAX_WORKSPACE_EVENT_ID_LENGTH = 128;
export const MAX_WORKSPACE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_WORKSPACE_VERSION = Number.MAX_SAFE_INTEGER;

/**
 * Text a person reads and writes. Control characters cannot be typed or displayed, and would reach
 * a terminal, a branch name, or a filesystem call as an escape sequence rather than as text.
 */
const HUMAN_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]+$";

/** An identifier nothing displays as prose: no space, no control character. */
const IDENTIFIER_PATTERN = "^[^\\u0000-\\u0020\\u007F-\\u009F]+$";

/**
 * What `git check-ref-format` accepts: slash-separated components with no space and no control
 * character, none of the characters Git reserves, no `..`, no `@{`, no `.lock` component, and no
 * component that begins or ends on a dot — including the components in the middle of a ref, which
 * Git refuses just as firmly as the last one.
 */
const GIT_REF_PATTERN =
    "^(?!@$)(?!/)(?!\\.)(?![\\s\\S]*//)(?![\\s\\S]*\\.\\.)(?![\\s\\S]*@\\{)" +
    "(?![\\s\\S]*\\.lock(?:/|$))(?![\\s\\S]*/\\.)(?![\\s\\S]*\\./)" +
    "[^\\u0000-\\u0020\\u007F~^:?*\\[\\\\]+(?<![./])$";

/**
 * An absolute folder path the host has already normalized: a POSIX root or a Windows drive, no
 * repeated separators, no `.` or `..` component, no trailing separator, no control character.
 */
const ABSOLUTE_PATH_PATTERN =
    "^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?![\\s\\S]*[/\\\\]\\.{1,2}(?:[/\\\\]|$))" +
    "(?:/(?:[^/]+/)*[^/]+|[A-Za-z]:\\\\(?:[^\\\\/]+\\\\)*[^\\\\/]+)$";

export const workspaceIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_ID_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

export const workspaceAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_AGENT_ID_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

export const workspaceOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_OPERATION_ID_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

/** The session that asked for this workspace, when one did. */
export const workspaceSessionIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_SESSION_ID_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

/** An opaque host-owned reference to a project. */
export const workspaceProjectRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PROJECT_REF_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

/**
 * A workspace lives below either another workspace or its project's implicit root. Projects do
 * not need duplicate root workspace rows: their ID is the root identity.
 */
export const workspaceParentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PROJECT_REF_LENGTH,
    pattern: IDENTIFIER_PATTERN,
});

export const workspaceNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_NAME_LENGTH,
    pattern: HUMAN_TEXT_PATTERN,
});

export const workspaceBaseRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_BASE_REF_LENGTH,
    pattern: GIT_REF_PATTERN,
});

/** Immutable commit the workspace was cut from; the anchor for every later comparison. */
export const workspaceCommitSchema = Type.String({
    minLength: 4,
    maxLength: MAX_WORKSPACE_COMMIT_LENGTH,
    pattern: "^[0-9a-fA-F]+$",
});

/** Branch Happy Agent manages for this workspace. It follows the workspace name. */
export const workspaceBranchSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_BRANCH_LENGTH,
    pattern: GIT_REF_PATTERN,
});

/** Portable folder key, unique within a project. */
export const workspaceStorageKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_STORAGE_KEY_LENGTH,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

/** Fractional key deciding where this workspace sits in the main list. */
export const workspaceOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_ORDER_KEY_LENGTH,
    pattern: "^[0-9]+$",
});

/** The folder this workspace lives in. Every workspace has one, and the host owns where it is. */
export const workspacePathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PATH_LENGTH,
    pattern: ABSOLUTE_PATH_PATTERN,
});

/** Shared Git directory the worktree belongs to, once Git discovery has run. */
export const workspaceGitCommonDirSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PATH_LENGTH,
    pattern: ABSOLUTE_PATH_PATTERN,
});

export const workspaceGitRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_GIT_REF_LENGTH,
    pattern: GIT_REF_PATTERN,
});

/**
 * A Git project gets a worktree. A project without Git gets a copied folder instead, which archives
 * differently: the worktree can be removed outright, the copy is left behind unless asked for.
 */
export const workspaceKindSchema = Type.Union([
    Type.Literal("git_worktree"),
    Type.Literal("directory"),
]);

/** Whether the folder was there the last time the host looked. */
export const workspacePresenceSchema = Type.Union([
    Type.Literal("present"),
    Type.Literal("missing"),
]);

export const workspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);

export const workspaceTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_TIMESTAMP,
});

/** Optimistic concurrency counter. Every durable mutation advances it by one. */
export const workspaceVersionSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_WORKSPACE_VERSION,
});

/** A sentence someone reads in the UI. Line breaks and tabs are the only control characters. */
export const workspaceErrorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_ERROR_LENGTH,
    pattern: "^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]+$",
});

export const workspaceDivergenceSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_DIVERGENCE,
});

export const workspaceMutationOperationSchema = Type.Union([
    Type.Literal("reserve"),
    Type.Literal("rename"),
    Type.Literal("inherit_name"),
    Type.Literal("set_branch"),
    Type.Literal("record_initialization"),
    Type.Literal("mark_ready"),
    Type.Literal("mark_failed"),
    Type.Literal("mark_initialization_failed"),
    Type.Literal("reorder"),
    Type.Literal("begin_archive"),
    Type.Literal("complete_archive"),
    Type.Literal("apply_git_facts"),
    Type.Literal("apply_probe"),
]);

/** Host-observed Git state for one workspace. */
export const workspaceGitFactsSchema = Type.Object(
    {
        branch: Type.Optional(workspaceBranchSchema),
        head: Type.Optional(workspaceGitRefSchema),
        upstream: Type.Optional(workspaceGitRefSchema),
        ahead: workspaceDivergenceSchema,
        behind: workspaceDivergenceSchema,
        detached: Type.Boolean(),
    },
    { additionalProperties: false },
);

/** Public workspace data. */
export const workspaceSchema = Type.Object(
    {
        id: workspaceIdSchema,
        projectRef: workspaceProjectRefSchema,
        parentId: workspaceParentIdSchema,
        name: workspaceNameSchema,
        /** False while the name is still a placeholder a first chat may replace. */
        nameConfigured: Type.Boolean(),
        branch: workspaceBranchSchema,
        storageKey: workspaceStorageKeySchema,
        kind: workspaceKindSchema,
        path: workspacePathSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
        baseCommit: Type.Optional(workspaceCommitSchema),
        gitCommonDir: Type.Optional(workspaceGitCommonDirSchema),
        presence: workspacePresenceSchema,
        status: workspaceStatusSchema,
        orderKey: workspaceOrderKeySchema,
        version: workspaceVersionSchema,
        creatorSessionId: Type.Optional(workspaceSessionIdSchema),
        gitAhead: workspaceDivergenceSchema,
        gitBehind: workspaceDivergenceSchema,
        gitDetached: Type.Boolean(),
        gitHead: Type.Optional(workspaceGitRefSchema),
        gitUpstream: Type.Optional(workspaceGitRefSchema),
        initializationAttempt: Type.Integer({
            minimum: 0,
            maximum: MAX_WORKSPACE_INITIALIZATION_ATTEMPT,
        }),
        initializationError: Type.Optional(workspaceErrorSchema),
        createdAt: workspaceTimestampSchema,
        updatedAt: workspaceTimestampSchema,
        archivedAt: Type.Optional(workspaceTimestampSchema),
    },
    { additionalProperties: false },
);

/**
 * Public reservation input. Durable tools pass their stable call ID as `operationId`; a repeated
 * call with that same ID converges on the workspace the first attempt reserved rather than making a
 * second one. The project is required: a workspace is always a folder inside a project someone
 * registered, never a row invented beside one.
 */
export const workspaceReserveInputSchema = Type.Object(
    {
        id: Type.Optional(workspaceIdSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
        projectRef: workspaceProjectRefSchema,
        /** Omit this to place the workspace directly under its project's implicit root. */
        parentId: Type.Optional(workspaceParentIdSchema),
        name: workspaceNameSchema,
        nameConfigured: Type.Optional(Type.Boolean()),
        kind: Type.Optional(workspaceKindSchema),
        baseRef: Type.Optional(workspaceBaseRefSchema),
        baseCommit: Type.Optional(workspaceCommitSchema),
        gitCommonDir: Type.Optional(workspaceGitCommonDirSchema),
        creatorSessionId: Type.Optional(workspaceSessionIdSchema),
        /**
         * Names both the storage key and the branch when Git's refs could not be read in full. It
         * carries the workspace's own identity, so an unreadable ref store cannot hide a branch
         * this reservation would otherwise collide with.
         */
        storageKeySeed: Type.Optional(workspaceStorageKeySchema),
    },
    { additionalProperties: false },
);

const workspaceAvailabilityAnswerSchema = Type.Union([
    Type.Boolean(),
    Type.Promise(Type.Boolean()),
]);

/**
 * The host's live view of Git and the filesystem, consulted before a reservation settles on a
 * name. They are passed beside the input rather than inside it because they are an observation
 * rather than durable data.
 *
 * Every reservation needs all three, from these hooks or from the module's host. A branch the
 * module cannot prove is free is a branch the checkout may fail on, so an absent probe fails the
 * reservation instead of allocating a name nobody checked. A probe that cannot read Git should
 * throw for the same reason.
 */
export const workspaceReserveHooksSchema = Type.Object(
    {
        isBranchUnavailable: Type.Optional(
            Type.Function([workspaceBranchSchema], workspaceAvailabilityAnswerSchema),
        ),
        isStorageKeyUnavailable: Type.Optional(
            Type.Function([workspaceStorageKeySchema], workspaceAvailabilityAnswerSchema),
        ),
        pathForStorageKey: Type.Optional(
            Type.Function([workspaceStorageKeySchema], workspacePathSchema),
        ),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; persistence identities remain module-owned. */
export const workspaceCreateToolInputSchema = Type.Object(
    {
        projectRef: workspaceProjectRefSchema,
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);

export const workspaceArchiveOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(workspaceOperationIdSchema),
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceRenameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        expectedVersion: Type.Optional(workspaceVersionSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; mutation identities remain module-owned. */
export const workspaceRenameToolInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
    },
    { additionalProperties: false },
);

/** First-chat naming. It replaces a placeholder name and nothing else. */
export const workspaceInheritNameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceReorderInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        afterId: Type.Union([workspaceIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(workspaceVersionSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

/** Lists one project's direct workspace children, in their durable sibling order. */
export const workspaceChildrenQuerySchema = Type.Object(
    {
        projectRef: workspaceProjectRefSchema,
        /** Defaults to `projectRef`, the project's implicit root. */
        parentId: Type.Optional(workspaceParentIdSchema),
        includeArchived: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** Records the branch a host actually created or renamed to. */
export const workspaceSetBranchInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        branch: workspaceBranchSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

/**
 * The Git facts resolved once a reservation became visible. All three describe one base decision,
 * so they land together or not at all.
 */
export const workspaceInitializationFactsSchema = Type.Object(
    {
        baseCommit: workspaceCommitSchema,
        baseRef: workspaceBaseRefSchema,
        gitCommonDir: workspaceGitCommonDirSchema,
    },
    { additionalProperties: false },
);

export const workspaceRecordInitializationInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        facts: workspaceInitializationFactsSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceMarkReadyInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceMarkFailedInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        error: workspaceErrorSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceApplyGitFactsInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        facts: workspaceGitFactsSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceApplyProbeInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        presence: workspacePresenceSchema,
        facts: workspaceGitFactsSchema,
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceId = Static<typeof workspaceIdSchema>;
export type WorkspaceAgentId = Static<typeof workspaceAgentIdSchema>;
export type WorkspaceOperationId = Static<typeof workspaceOperationIdSchema>;
export type WorkspaceSessionId = Static<typeof workspaceSessionIdSchema>;
export type WorkspaceProjectRef = Static<typeof workspaceProjectRefSchema>;
export type WorkspaceParentId = Static<typeof workspaceParentIdSchema>;
export type WorkspaceName = Static<typeof workspaceNameSchema>;
export type WorkspaceBaseRef = Static<typeof workspaceBaseRefSchema>;
export type WorkspaceBranch = Static<typeof workspaceBranchSchema>;
export type WorkspaceStorageKey = Static<typeof workspaceStorageKeySchema>;
export type WorkspaceOrderKey = Static<typeof workspaceOrderKeySchema>;
export type WorkspacePath = Static<typeof workspacePathSchema>;
export type WorkspaceKind = Static<typeof workspaceKindSchema>;
export type WorkspacePresence = Static<typeof workspacePresenceSchema>;
export type WorkspaceStatus = Static<typeof workspaceStatusSchema>;
export type WorkspaceVersion = Static<typeof workspaceVersionSchema>;
export type WorkspaceGitFacts = Static<typeof workspaceGitFactsSchema>;
export type WorkspaceMutationOperation = Static<typeof workspaceMutationOperationSchema>;
export type Workspace = Static<typeof workspaceSchema>;
export type WorkspaceReserveInput = Static<typeof workspaceReserveInputSchema>;
export type WorkspaceReserveHooks = Static<typeof workspaceReserveHooksSchema>;
export type WorkspaceCreateToolInput = Static<typeof workspaceCreateToolInputSchema>;
export type WorkspaceArchiveOptions = Static<typeof workspaceArchiveOptionsSchema>;
export type WorkspaceRenameInput = Static<typeof workspaceRenameInputSchema>;
export type WorkspaceRenameToolInput = Static<typeof workspaceRenameToolInputSchema>;
export type WorkspaceInheritNameInput = Static<typeof workspaceInheritNameInputSchema>;
export type WorkspaceReorderInput = Static<typeof workspaceReorderInputSchema>;
export type WorkspaceChildrenQuery = Static<typeof workspaceChildrenQuerySchema>;
export type WorkspaceSetBranchInput = Static<typeof workspaceSetBranchInputSchema>;
export type WorkspaceInitializationFacts = Static<typeof workspaceInitializationFactsSchema>;
export type WorkspaceRecordInitializationInput = Static<
    typeof workspaceRecordInitializationInputSchema
>;
export type WorkspaceMarkReadyInput = Static<typeof workspaceMarkReadyInputSchema>;
export type WorkspaceMarkFailedInput = Static<typeof workspaceMarkFailedInputSchema>;
export type WorkspaceApplyGitFactsInput = Static<typeof workspaceApplyGitFactsInputSchema>;
export type WorkspaceApplyProbeInput = Static<typeof workspaceApplyProbeInputSchema>;
