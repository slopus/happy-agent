/** Workspaces: a checkout with its own folder, its own branch, and its place in a tree. */

import { type Static, Type } from "@sinclair/typebox";

import {
    computeSchema,
    cuid2Schema,
    gitSummarySchema,
    initializationStateSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { agentSchema } from "./agents.js";

/** What the workspace was created from. */
export const workspaceBaseSchema = Type.Object({
    /** The commit the ref resolved to at creation time. */
    commit: Type.String(),
    /** The ref the caller named. */
    ref: Type.String(),
});
export type WorkspaceBase = Static<typeof workspaceBaseSchema>;

/** The workspace object. A project's root workspace shares the project's ID. */
export const workspaceSchema = Type.Object({
    /** Ordered top-level agents rooted directly in this workspace. */
    agents: Type.Array(agentSchema),
    archivedAt: Nullable(timestampSchema),
    /** `null` on a root workspace, which was not branched from anything. */
    base: Nullable(workspaceBaseSchema),
    /** The owning bot on a dedicated bot workspace; `null` on ordinary workspaces. */
    botId: Type.Optional(Nullable(cuid2Schema)),
    compute: computeSchema,
    createdAt: timestampSchema,
    /** The agent that created this workspace; `null` when a person did. */
    creatorAgentId: Nullable(cuid2Schema),
    git: Nullable(gitSummarySchema),
    id: cuid2Schema,
    initialization: initializationStateSchema,
    /** How the checkout was made. */
    kind: Type.Union([
        Type.Literal("root"),
        Type.Literal("worktree"),
        Type.Literal("copy"),
        Type.Literal("bot"),
    ]),
    /** The display name, which is also the branch name behind the checkout. */
    name: Type.String(),
    nameSource: Type.Union([Type.Literal("user"), Type.Literal("generated")]),
    /** Orders this workspace among the siblings sharing its parent. */
    orderKey: Type.String(),
    /** `null` on a root workspace and on a bot workspace. */
    parentId: Nullable(cuid2Schema),
    /** The root of this workspace's tree; `null` on a bot workspace. */
    projectId: Nullable(cuid2Schema),
    /** `"archiving"` is the window where the decision is durable but cleanup runs. */
    status: Type.Union([
        Type.Literal("active"),
        Type.Literal("archiving"),
        Type.Literal("archived"),
    ]),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type Workspace = Static<typeof workspaceSchema>;

/** `GET /v0/workspaces` — a flat array; clients build the tree from `parentId`. */
export const workspaceListResponseSchema = Type.Object({
    workspaces: Type.Array(workspaceSchema),
});
export type WorkspaceListResponse = Static<typeof workspaceListResponseSchema>;

/** Every single-workspace route answers with this. */
export const workspaceResponseSchema = Type.Object({ workspace: workspaceSchema });
export type WorkspaceResponse = Static<typeof workspaceResponseSchema>;

/** `GET /v0/workspaces` query parameters. */
export const listWorkspacesQuerySchema = Type.Object({
    /** Archived and archiving workspaces are history; default `false`. */
    includeArchived: Type.Optional(Type.Boolean()),
    /** Only this project's tree. */
    projectId: Type.Optional(cuid2Schema),
});
export type ListWorkspacesQuery = Static<typeof listWorkspacesQuerySchema>;

/** `POST /v0/workspaces` */
export const createWorkspaceRequestSchema = Type.Object({
    /** Records the creating agent as `creatorAgentId`. */
    agentId: Type.Optional(cuid2Schema),
    /** The ref to branch from; defaults to the parent's current branch. */
    baseRef: Type.Optional(Type.String()),
    /** Optional client-supplied ID. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    /** The workspace name, which is also its branch name. */
    name: Type.String(),
    /** False when `name` is a placeholder the first chat should replace. Defaults to true. */
    nameConfigured: Type.Optional(Type.Boolean()),
    /** The workspace to nest under: a root workspace or any workspace in a tree. */
    parentId: cuid2Schema,
});
export type CreateWorkspaceRequest = Static<typeof createWorkspaceRequestSchema>;

/** `PATCH /v0/workspaces/:workspaceId` */
export const renameWorkspaceRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.String(),
});
export type RenameWorkspaceRequest = Static<typeof renameWorkspaceRequestSchema>;

/** `POST /v0/workspaces/:workspaceId/archive` */
export const archiveWorkspaceRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ArchiveWorkspaceRequest = Static<typeof archiveWorkspaceRequestSchema>;

/** `POST /v0/workspaces/:workspaceId/reorder` */
export const reorderWorkspaceRequestSchema = Type.Object({
    /** The sibling to place this one after, or `null` to move it first. */
    afterId: Nullable(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderWorkspaceRequest = Static<typeof reorderWorkspaceRequestSchema>;
