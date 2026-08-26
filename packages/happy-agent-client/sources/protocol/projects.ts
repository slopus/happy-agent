/** Projects: a folder registered with the daemon, or a repository it cloned. */

import { type Static, Type } from "@sinclair/typebox";

import {
    computeSchema,
    computeSelectionSchema,
    cuid2Schema,
    gitSummarySchema,
    initializationStateSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { agentSchema } from "./agents.js";

/** Where a cloned project came from; `null` for a registered local folder. */
export const remoteSourceSchema = Type.Union([
    Type.Object({ kind: Type.Literal("github"), repository: Type.String() }),
    Type.Object({ kind: Type.Literal("git"), url: Type.String() }),
]);
export type RemoteSource = Static<typeof remoteSourceSchema>;

/**
 * The project picture.
 *
 * The built-in home project — the user's machine outside any repository —
 * carries `{ kind: "home" }` and has no image bytes to fetch.
 */
export const projectAvatarSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("image"),
        source: Type.Union([Type.Literal("user"), Type.Literal("generated")]),
        thumbhash: Type.String(),
    }),
    Type.Object({ kind: Type.Literal("home") }),
]);
export type ProjectAvatar = Static<typeof projectAvatarSchema>;

/** Per-project preferences that new work inherits. */
export const projectSettingsSchema = Type.Object({
    /** Where new workspaces of this project run. */
    defaultWorkspaceCompute: computeSelectionSchema,
});
export type ProjectSettings = Static<typeof projectSettingsSchema>;

/** The project object. A project is also the root workspace of its tree. */
export const projectSchema = Type.Object({
    /** Ordered top-level agents rooted directly in this project workspace. */
    agents: Type.Array(agentSchema),
    archivedAt: Nullable(timestampSchema),
    avatar: Nullable(projectAvatarSchema),
    compute: computeSchema,
    createdAt: timestampSchema,
    defaultBranch: Nullable(Type.String()),
    description: Nullable(Type.String()),
    /** `null` when the folder is not a Git repository. */
    git: Nullable(gitSummarySchema),
    id: cuid2Schema,
    initialization: initializationStateSchema,
    name: Type.String(),
    /** Where the name came from; a user-chosen name is never derived over. */
    nameSource: Type.Union([Type.Literal("folder"), Type.Literal("user")]),
    /** An opaque sort key; clients order projects by comparing these strings. */
    orderKey: Type.String(),
    remoteSource: Nullable(remoteSourceSchema),
    settings: projectSettingsSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
    /** Whether child workspaces can be created as Git worktrees. */
    worktreeSupport: Type.Union([
        Type.Literal("supported"),
        Type.Literal("unsupported"),
        Type.Literal("unknown"),
    ]),
    /** Accompanies `worktreeSupport` of `"unsupported"`. */
    worktreeUnsupportedReason: Type.Optional(Type.String()),
});
export type Project = Static<typeof projectSchema>;

/** `GET /v0/projects` */
export const projectListResponseSchema = Type.Object({ projects: Type.Array(projectSchema) });
export type ProjectListResponse = Static<typeof projectListResponseSchema>;

/** Every single-project route answers with this. */
export const projectResponseSchema = Type.Object({ project: projectSchema });
export type ProjectResponse = Static<typeof projectResponseSchema>;

/** `PUT /v0/projects/:projectId/settings` */
export const projectSettingsResponseSchema = Type.Object({
    project: projectSchema,
    settings: projectSettingsSchema,
});
export type ProjectSettingsResponse = Static<typeof projectSettingsResponseSchema>;

/** `POST /v0/projects` — registers an existing local folder. */
export const registerProjectRequestSchema = Type.Object({
    /** The folder to register. Must exist and be a directory. */
    path: Type.String(),
    /** Optional client-supplied ID, for callers that need it before the answer. */
    projectId: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type RegisterProjectRequest = Static<typeof registerProjectRequestSchema>;

/** `POST /v0/projects/clone` */
export const cloneProjectRequestSchema = Type.Object({
    /** The folder name for the clone. */
    name: Type.String(),
    projectId: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    /** Names the stored credential kind to clone with. */
    secret: Type.Optional(Type.Object({ kind: Type.Literal("github") })),
    source: remoteSourceSchema,
});
export type CloneProjectRequest = Static<typeof cloneProjectRequestSchema>;

/** `PATCH /v0/projects/:projectId` */
export const renameProjectRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.String(),
});
export type RenameProjectRequest = Static<typeof renameProjectRequestSchema>;

/** `PUT /v0/projects/:projectId/settings` */
export const replaceProjectSettingsRequestSchema = Type.Object({
    defaultWorkspaceCompute: computeSelectionSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReplaceProjectSettingsRequest = Static<typeof replaceProjectSettingsRequestSchema>;

/** `POST /v0/projects/:projectId/reorder` */
export const reorderProjectRequestSchema = Type.Object({
    /** The project to place this one after, or `null` to move it first. */
    afterId: Nullable(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderProjectRequest = Static<typeof reorderProjectRequestSchema>;

/** `POST /v0/projects/:projectId/archive` */
export const archiveProjectRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ArchiveProjectRequest = Static<typeof archiveProjectRequestSchema>;
