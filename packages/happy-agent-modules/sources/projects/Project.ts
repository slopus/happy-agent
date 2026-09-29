import { Type, type Static } from "@sinclair/typebox";

/**
 * A project is one canonical folder on the host machine. Identity is the
 * folder: the catalog holds exactly one project per canonical path, and the
 * portable storage key is what the host uses to derive managed directories
 * for that project and its workspaces.
 */
export const MAX_PROJECT_ID_LENGTH = 96;
export const MAX_PROJECT_AGENT_ID_LENGTH = 96;
export const MAX_PROJECT_REPOSITORY_REF_LENGTH = 4_096;
export const MAX_PROJECT_STORAGE_KEY_LENGTH = 64;
export const MAX_PROJECT_NAME_LENGTH = 500;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2_000;
export const MAX_PROJECT_EVENT_ID_LENGTH = 128;
/** 1 January 2200, in milliseconds. A timestamp beyond this is a bug, not a date. */
export const MAX_PROJECT_TIMESTAMP = 7_258_118_400_000;
export const MAX_PROJECT_VERSION = Number.MAX_SAFE_INTEGER;
export const MAX_PROJECT_ORDER_KEY_LENGTH = 128;
export const MAX_PROJECT_AVATAR_CONTENT_HASH_LENGTH = 64;
export const MAX_PROJECT_AVATAR_DIMENSION = 16_384;
export const MAX_PROJECT_AVATAR_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_AVATAR_THUMBHASH_LENGTH = 128;
/** Longest human-readable failure detail kept on one project row. */
export const MAX_PROJECT_ERROR_LENGTH = 500;
export const MAX_PROJECT_GIT_REF_LENGTH = 512;
export const MAX_PROJECT_GIT_DIVERGENCE = 1_000_000;
export const MAX_PROJECT_INITIALIZATION_ATTEMPTS = 1_000_000;
export const MAX_PROJECT_REMOTE_URL_LENGTH = 2_048;
export const MAX_PROJECT_WORKSPACE_SETUP_COMMANDS = 100;
export const MAX_PROJECT_WORKSPACE_SETUP_COMMAND_LENGTH = 4_096;

/**
 * These are written as explicit code-point ranges rather than Unicode property escapes because a
 * JSON Schema `pattern` is compiled without the `u` flag: `\p{Cc}` would match the letter `p`.
 */

/**
 * Text a person reads and writes. Control characters cannot be typed or displayed, and would reach
 * a terminal, a branch name, or a filesystem call as an escape sequence rather than as text.
 */
const PROJECT_HUMAN_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]+$";

/** An identifier nothing displays as prose: no space, no control character. */
const PROJECT_IDENTIFIER_PATTERN = "^[^\\u0000-\\u0020\\u007F-\\u009F]+$";

/**
 * What `git check-ref-format` accepts: slash-separated components with no space and no control
 * character, none of the characters Git reserves, no `..`, no `@{`, no `.lock` component, and
 * nothing that begins or ends on a dot or a slash.
 */
const PROJECT_GIT_REF_PATTERN =
    "^(?!@$)(?!/)(?!\\.)(?![\\s\\S]*//)(?![\\s\\S]*\\.\\.)(?![\\s\\S]*@\\{)" +
    "(?![\\s\\S]*\\.lock(?:/|$))(?![\\s\\S]*/\\.)" +
    "[^\\u0000-\\u0020\\u007F~^:?*\\[\\\\]+(?<![./])$";

/**
 * An absolute folder path the host has already normalized: a POSIX root or a Windows drive, no
 * repeated separators, no `.` or `..` component, no trailing separator, no control character.
 */
const PROJECT_ABSOLUTE_PATH_PATTERN =
    "^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?![\\s\\S]*[/\\\\]\\.{1,2}(?:[/\\\\]|$))" +
    "(?:/(?:[^/]+/)*[^/]+|[A-Za-z]:[/\\\\](?:[^/\\\\]+[/\\\\])*[^/\\\\]+)$";

/**
 * An HTTPS remote with no credentials in it, which is the only thing the clone boundary will
 * actually run. A URL the catalog accepts but the clone refuses is a project that can never
 * finish being set up. The host may carry a port, and a port is digits: anything else there is a
 * URL a clone cannot resolve.
 */
const PROJECT_REMOTE_URL_PATTERN =
    "^https://(?![^/?#]*@)[^\\u0000-\\u0020\\u007F/?#:@]+(?::[0-9]+)?" +
    "(?:[/?#][^\\u0000-\\u0020\\u007F]*)?$";

function projectVisibleIdentifierSchemaFor(maxLength: number) {
    return Type.String({
        minLength: 1,
        maxLength,
        pattern: PROJECT_IDENTIFIER_PATTERN,
    });
}

export const projectIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_ID_LENGTH);

export const projectAgentIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_AGENT_ID_LENGTH);

/**
 * The canonical absolute folder path of the project. It is not an opaque
 * reference: a project is the folder, so the value must be an absolute POSIX
 * or Windows path with no NUL and no line break. The host canonicalizes the
 * path before it reaches the catalog; the catalog keeps one project per path.
 */
export const projectRepositoryRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_REPOSITORY_REF_LENGTH,
    pattern: PROJECT_ABSOLUTE_PATH_PATTERN,
});

/**
 * Portable lower-case key derived from the project name. Managed project and
 * workspace directories are built from it, so it stays filesystem-safe.
 */
export const projectStorageKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_STORAGE_KEY_LENGTH,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

/** The user's home directory is one project of kind "home"; it is never initialized. */
export const projectKindSchema = Type.Union([Type.Literal("home"), Type.Literal("regular")]);

/** Whether the folder backing the project still exists on the host. */
export const projectPresenceSchema = Type.Union([Type.Literal("present"), Type.Literal("missing")]);

export const projectInitializationStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
]);

export const projectInitializationAttemptSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_INITIALIZATION_ATTEMPTS,
});

/** A sentence someone reads in the UI. Line breaks and tabs are the only control characters. */
export const projectErrorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_ERROR_LENGTH,
    pattern: "^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]+$",
});

/**
 * Where the display name came from. A folder-derived name may later be
 * replaced by the remote repository's name; a name the user chose never is.
 */
export const projectNameSourceSchema = Type.Union([
    Type.Literal("folder"),
    Type.Literal("user"),
    Type.Literal("remote"),
]);

export const projectNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_NAME_LENGTH,
    pattern: PROJECT_HUMAN_TEXT_PATTERN,
});

export const projectDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_DESCRIPTION_LENGTH,
    pattern: PROJECT_HUMAN_TEXT_PATTERN,
});

export const projectEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_EVENT_ID_LENGTH,
    pattern: PROJECT_IDENTIFIER_PATTERN,
});

export const projectGitRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_GIT_REF_LENGTH,
    pattern: PROJECT_GIT_REF_PATTERN,
});

/** Whether the host can cut a managed worktree from this project. */
export const projectWorktreeSupportSchema = Type.Union([
    Type.Literal("supported"),
    Type.Literal("unsupported"),
    Type.Literal("unknown"),
]);

export const projectGitHubRepositorySchema = Type.String({
    maxLength: 201,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$",
});

/** The remote repository the host manages inside this project's folder. */
export const projectRemoteSourceSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("github"),
            repository: projectGitHubRepositorySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("git"),
            url: Type.String({
                minLength: 1,
                maxLength: MAX_PROJECT_REMOTE_URL_LENGTH,
                pattern: PROJECT_REMOTE_URL_PATTERN,
            }),
        },
        { additionalProperties: false },
    ),
]);

/** Credential kind a retry of the clone needs. Secret material is never persisted here. */
export const projectRequiredSecretKindSchema = Type.Literal("github");

export const projectGitDivergenceSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_GIT_DIVERGENCE,
});

/** Slow-moving Git facts a host probe reports for one folder. */
export const projectGitFactsSchema = Type.Object(
    {
        ahead: projectGitDivergenceSchema,
        behind: projectGitDivergenceSchema,
        branch: Type.Optional(projectGitRefSchema),
        detached: Type.Boolean(),
        head: Type.Optional(projectGitRefSchema),
        upstream: Type.Optional(projectGitRefSchema),
    },
    { additionalProperties: false },
);

/**
 * One shell command a new workspace of this project runs once its checkout exists. It is the
 * text of the repository's `happy.toml` as written, bounded but otherwise untouched: NUL is the
 * only character no shell can be handed.
 */
export const projectWorkspaceSetupCommandSchema = Type.String({
    maxLength: MAX_PROJECT_WORKSPACE_SETUP_COMMAND_LENGTH,
    pattern: "^[^\\u0000]*$",
});

/**
 * The ordered setup commands the workspaces catalog last read from the project's own
 * `happy.toml`, over the machine's defaults. A cache of the file for clients to show, never the
 * list a workspace actually runs — that is read from the checkout at the moment it is prepared.
 */
export const projectWorkspaceSetupCommandsSchema = Type.Array(projectWorkspaceSetupCommandSchema, {
    maxItems: MAX_PROJECT_WORKSPACE_SETUP_COMMANDS,
});

export const projectTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_TIMESTAMP,
});

export const projectVersionSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_PROJECT_VERSION,
});

export const projectOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_ORDER_KEY_LENGTH,
    pattern: "^[0-9]+$",
});

export const projectAvatarContentHashSchema = Type.String({
    minLength: MAX_PROJECT_AVATAR_CONTENT_HASH_LENGTH,
    maxLength: MAX_PROJECT_AVATAR_CONTENT_HASH_LENGTH,
    pattern: "^[a-f0-9]{64}$",
});

export const projectAvatarContentTypeSchema = Type.Literal("image/webp");

export const projectAvatarSourceSchema = Type.Union([
    Type.Literal("user"),
    Type.Literal("generated"),
]);

export const projectAvatarThumbhashSchema = Type.String({
    minLength: 4,
    maxLength: MAX_PROJECT_AVATAR_THUMBHASH_LENGTH,
});

export const projectAvatarSchema = Type.Object(
    {
        kind: Type.Literal("image"),
        source: projectAvatarSourceSchema,
        thumbhash: projectAvatarThumbhashSchema,
    },
    { additionalProperties: false },
);

export const projectAvatarAssetSchema = Type.Object(
    {
        bytes: Type.Uint8Array({
            minByteLength: 1,
            maxByteLength: MAX_PROJECT_AVATAR_BYTES,
        }),
        contentHash: projectAvatarContentHashSchema,
        contentType: projectAvatarContentTypeSchema,
        etag: Type.String({ minLength: 66, maxLength: 66, pattern: '^"[a-f0-9]{64}"$' }),
        height: Type.Integer({ minimum: 1, maximum: MAX_PROJECT_AVATAR_DIMENSION }),
        thumbhash: projectAvatarThumbhashSchema,
        width: Type.Integer({ minimum: 1, maximum: MAX_PROJECT_AVATAR_DIMENSION }),
    },
    { additionalProperties: false },
);

export const projectAvatarUploadContentTypeSchema = Type.Union([
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/webp"),
]);

export const projectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);

export const projectMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("ensure"),
    Type.Literal("rename"),
    Type.Literal("archive"),
    Type.Literal("restore"),
    Type.Literal("reorder"),
    Type.Literal("set_avatar"),
    Type.Literal("clear_avatar"),
    Type.Literal("update_settings"),
    Type.Literal("state_change"),
]);

export const projectSchema = Type.Object(
    {
        id: projectIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        kind: projectKindSchema,
        storageKey: projectStorageKeySchema,
        name: projectNameSchema,
        nameSource: projectNameSourceSchema,
        status: projectStatusSchema,
        presence: projectPresenceSchema,
        initializationStatus: projectInitializationStatusSchema,
        initializationAttempt: projectInitializationAttemptSchema,
        initializationError: Type.Optional(projectErrorSchema),
        defaultBranch: Type.Optional(projectGitRefSchema),
        worktreeSupport: projectWorktreeSupportSchema,
        worktreeUnsupportedReason: Type.Optional(projectErrorSchema),
        remoteSource: Type.Optional(projectRemoteSourceSchema),
        requiredSecretKind: Type.Optional(projectRequiredSecretKindSchema),
        gitAhead: projectGitDivergenceSchema,
        gitBehind: projectGitDivergenceSchema,
        gitDetached: Type.Boolean(),
        gitBranch: Type.Optional(projectGitRefSchema),
        gitHead: Type.Optional(projectGitRefSchema),
        gitUpstream: Type.Optional(projectGitRefSchema),
        /** Absent until the workspaces catalog has read the project's `happy.toml` once. */
        workspaceSetupCommands: Type.Optional(projectWorkspaceSetupCommandsSchema),
        orderKey: projectOrderKeySchema,
        version: projectVersionSchema,
        avatar: Type.Optional(projectAvatarSchema),
        description: Type.Optional(projectDescriptionSchema),
        createdAt: projectTimestampSchema,
        updatedAt: projectTimestampSchema,
        archivedAt: Type.Optional(projectTimestampSchema),
    },
    { additionalProperties: false },
);

/** Host-facing create input. The durable identity is omitted from tool input. */
export const projectCreateInputSchema = Type.Object(
    {
        id: Type.Optional(projectIdSchema),
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        nameSource: Type.Optional(projectNameSourceSchema),
        kind: Type.Optional(projectKindSchema),
        description: Type.Optional(projectDescriptionSchema),
        remoteSource: Type.Optional(projectRemoteSourceSchema),
        requiredSecretKind: Type.Optional(projectRequiredSecretKindSchema),
    },
    { additionalProperties: false },
);

export const projectCreateToolInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

/**
 * Ensure is called with a folder the host has just resolved. It converges on
 * one project for that folder and restores it when it was archived.
 */
export const projectEnsureInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(projectNameSchema),
        nameSource: Type.Optional(projectNameSourceSchema),
        kind: Type.Optional(projectKindSchema),
        description: Type.Optional(projectDescriptionSchema),
        remoteSource: Type.Optional(projectRemoteSourceSchema),
        requiredSecretKind: Type.Optional(projectRequiredSecretKindSchema),
    },
    { additionalProperties: false },
);

export const projectRenameInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

/** Every operation that only needs to name one project shares this input. */
export const projectByIdInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectReorderInputSchema = Type.Object(
    {
        afterId: Type.Union([projectIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectSetAvatarInputSchema = Type.Union([
    Type.Object(
        {
            bytes: Type.Uint8Array({
                minByteLength: 1,
                maxByteLength: MAX_PROJECT_AVATAR_BYTES,
            }),
            contentType: projectAvatarUploadContentTypeSchema,
            expectedVersion: Type.Optional(projectVersionSchema),
            projectId: projectIdSchema,
            source: Type.Literal("user"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            bytes: Type.Uint8Array({
                minByteLength: 1,
                maxByteLength: MAX_PROJECT_AVATAR_BYTES,
            }),
            contentType: Type.Optional(projectAvatarUploadContentTypeSchema),
            expectedVersion: Type.Optional(projectVersionSchema),
            projectId: projectIdSchema,
            source: Type.Literal("generated"),
        },
        { additionalProperties: false },
    ),
]);

export const projectClearAvatarInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

/** What a host probe of the project folder observed. */
export const projectProbeInputSchema = Type.Object(
    {
        git: Type.Optional(projectGitFactsSchema),
        presence: projectPresenceSchema,
        projectId: projectIdSchema,
        worktreeSupport: projectWorktreeSupportSchema,
        worktreeUnsupportedReason: Type.Optional(projectErrorSchema),
    },
    { additionalProperties: false },
);

export const projectGitFactsInputSchema = Type.Object(
    {
        git: projectGitFactsSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

/** The setup commands another catalog read from the project's `happy.toml`. */
export const projectWorkspaceSetupCommandsInputSchema = Type.Object(
    {
        commands: projectWorkspaceSetupCommandsSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectSetDefaultBranchInputSchema = Type.Object(
    {
        branch: projectGitRefSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectAdoptRemoteNameInputSchema = Type.Object(
    {
        name: projectNameSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectInitializationFailureInputSchema = Type.Object(
    {
        error: projectErrorSchema,
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export type ProjectId = Static<typeof projectIdSchema>;
export type ProjectAgentId = Static<typeof projectAgentIdSchema>;
export type ProjectRepositoryRef = Static<typeof projectRepositoryRefSchema>;
export type ProjectStorageKey = Static<typeof projectStorageKeySchema>;
export type ProjectKind = Static<typeof projectKindSchema>;
export type ProjectPresence = Static<typeof projectPresenceSchema>;
export type ProjectInitializationStatus = Static<typeof projectInitializationStatusSchema>;
export type ProjectNameSource = Static<typeof projectNameSourceSchema>;
export type ProjectName = Static<typeof projectNameSchema>;
export type ProjectDescription = Static<typeof projectDescriptionSchema>;
export type ProjectEventId = Static<typeof projectEventIdSchema>;
export type ProjectGitRef = Static<typeof projectGitRefSchema>;
export type ProjectGitFacts = Static<typeof projectGitFactsSchema>;
export type ProjectWorktreeSupport = Static<typeof projectWorktreeSupportSchema>;
export type ProjectRemoteSource = Static<typeof projectRemoteSourceSchema>;
export type ProjectRequiredSecretKind = Static<typeof projectRequiredSecretKindSchema>;
export type ProjectTimestamp = Static<typeof projectTimestampSchema>;
export type ProjectVersion = Static<typeof projectVersionSchema>;
export type ProjectOrderKey = Static<typeof projectOrderKeySchema>;
export type ProjectAvatarContentHash = Static<typeof projectAvatarContentHashSchema>;
export type ProjectAvatarContentType = Static<typeof projectAvatarContentTypeSchema>;
export type ProjectAvatarSource = Static<typeof projectAvatarSourceSchema>;
export type ProjectAvatarThumbhash = Static<typeof projectAvatarThumbhashSchema>;
export type ProjectAvatarUploadContentType = Static<typeof projectAvatarUploadContentTypeSchema>;
export type ProjectAvatar = Static<typeof projectAvatarSchema>;
export type ProjectAvatarAsset = Static<typeof projectAvatarAssetSchema>;
export type ProjectStatus = Static<typeof projectStatusSchema>;
export type ProjectMutationOperation = Static<typeof projectMutationOperationSchema>;
export type Project = Static<typeof projectSchema>;
export type ProjectCreateInput = Static<typeof projectCreateInputSchema>;
export type ProjectCreateToolInput = Static<typeof projectCreateToolInputSchema>;
export type ProjectEnsureInput = Static<typeof projectEnsureInputSchema>;
export type ProjectRenameInput = Static<typeof projectRenameInputSchema>;
export type ProjectByIdInput = Static<typeof projectByIdInputSchema>;
export type ProjectReorderInput = Static<typeof projectReorderInputSchema>;
export type ProjectSetAvatarInput = Static<typeof projectSetAvatarInputSchema>;
export type ProjectClearAvatarInput = Static<typeof projectClearAvatarInputSchema>;
export type ProjectProbeInput = Static<typeof projectProbeInputSchema>;
export type ProjectGitFactsInput = Static<typeof projectGitFactsInputSchema>;
export type ProjectWorkspaceSetupCommands = Static<typeof projectWorkspaceSetupCommandsSchema>;
export type ProjectWorkspaceSetupCommandsInput = Static<
    typeof projectWorkspaceSetupCommandsInputSchema
>;
export type ProjectSetDefaultBranchInput = Static<typeof projectSetDefaultBranchInputSchema>;
export type ProjectAdoptRemoteNameInput = Static<typeof projectAdoptRemoteNameInputSchema>;
export type ProjectInitializationFailureInput = Static<
    typeof projectInitializationFailureInputSchema
>;
