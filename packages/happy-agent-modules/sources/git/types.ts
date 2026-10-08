import { Type, type Static } from "@sinclair/typebox";

export const gitRemoteSourceSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("github"),
            repository: Type.String({ minLength: 3, maxLength: 201 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("git"),
            url: Type.String({ minLength: 1, maxLength: 16_384 }),
        },
        { additionalProperties: false },
    ),
]);
export type GitRemoteSource = Static<typeof gitRemoteSourceSchema>;

export const projectCreatorSchema = Type.Object(
    {
        instanceId: Type.String({ minLength: 1, maxLength: 128 }),
        profileId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);
export type ProjectCreator = Static<typeof projectCreatorSchema>;

export const gitRepositoryFactsSchema = Type.Object(
    {
        ahead: Type.Integer({ minimum: 0 }),
        behind: Type.Integer({ minimum: 0 }),
        branch: Type.Optional(Type.String()),
        detached: Type.Boolean(),
        head: Type.Optional(Type.String()),
        upstream: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type GitRepositoryFacts = Static<typeof gitRepositoryFactsSchema>;

export const gitFileChangeStatusSchema = Type.Union([
    Type.Literal("added"),
    Type.Literal("conflicted"),
    Type.Literal("copied"),
    Type.Literal("deleted"),
    Type.Literal("modified"),
    Type.Literal("renamed"),
    Type.Literal("submodule"),
    Type.Literal("type_changed"),
    Type.Literal("untracked"),
]);
export type GitFileChangeStatus = Static<typeof gitFileChangeStatusSchema>;

export const gitFileChangeSchema = Type.Object(
    {
        binary: Type.Boolean(),
        contentToken: Type.Optional(Type.String()),
        deletions: Type.Optional(Type.Integer({ minimum: 0 })),
        insertions: Type.Optional(Type.Integer({ minimum: 0 })),
        newBytes: Type.Optional(Type.Uint8Array()),
        oldBytes: Type.Optional(Type.Uint8Array()),
        path: Type.String(),
        previousPath: Type.Optional(Type.String()),
        staged: Type.Boolean(),
        status: gitFileChangeStatusSchema,
        unstaged: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type GitFileChange = Static<typeof gitFileChangeSchema>;

export const gitChangeStateSchema = Type.Object(
    {
        base: Type.Optional(Type.String()),
        /** The full branch ref `base` was measured from; absent for HEAD and the empty tree. */
        baseRef: Type.Optional(Type.String()),
        changedFiles: Type.Integer({ minimum: 0 }),
        comparison: Type.Union([Type.Literal("ready"), Type.Literal("unavailable")]),
        conflicted: Type.Boolean(),
        countsExact: Type.Boolean(),
        deletions: Type.Integer({ minimum: 0 }),
        error: Type.Optional(Type.String()),
        facts: gitRepositoryFactsSchema,
        files: Type.Array(gitFileChangeSchema),
        filesTruncated: Type.Boolean(),
        insertions: Type.Integer({ minimum: 0 }),
        scannedAt: Type.Number(),
    },
    { additionalProperties: false },
);
export type GitChangeState = Static<typeof gitChangeStateSchema>;

export const gitChangeSnapshotSchema = Type.Composite([
    gitChangeStateSchema,
    Type.Object({
        generation: Type.String({ minLength: 1 }),
        version: Type.Integer({ minimum: 1 }),
    }),
]);
export type GitChangeSnapshot = Static<typeof gitChangeSnapshotSchema>;

export const gitTrackedEntitySchema = Type.Object(
    {
        path: Type.String({ minLength: 1 }),
        projectId: Type.String({ minLength: 1 }),
        workspaceId: Type.Optional(Type.String({ minLength: 1 })),
        /** The runner the repository lives on; absent for a repository on this machine. */
        runnerId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    },
    { additionalProperties: false },
);
export type GitTrackedEntity = Static<typeof gitTrackedEntitySchema>;

/** One repository's change snapshot, addressed the way a live subscriber reads it. */
export const gitLiveSnapshotSchema = Type.Object(
    {
        createdAt: Type.Number(),
        data: Type.Object({ git: gitChangeSnapshotSchema }),
        id: Type.String({ minLength: 1 }),
        projectId: Type.String({ minLength: 1 }),
        type: Type.Union([
            Type.Literal("project_git_changed"),
            Type.Literal("workspace_git_changed"),
        ]),
        workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type GitLiveSnapshot = Static<typeof gitLiveSnapshotSchema>;

export type { GitCommandResult, GitCommandRunner } from "./GitCommandRunner.js";
