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
import { surfaceIdSchema } from "./surfaces.js";
import { workspaceServiceCleanupSchema } from "./services.js";

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
        Type.Literal("task"),
        Type.Literal("surface"),
    ]),
    /** The display name, which is also the branch name behind the checkout. */
    name: Type.String(),
    nameSource: Type.Union([Type.Literal("user"), Type.Literal("generated")]),
    /** Orders this workspace among the siblings sharing its parent. */
    orderKey: Type.String(),
    /** `null` on a root workspace and on a bot, task, or Surface chat workspace. */
    parentId: Nullable(cuid2Schema),
    /** The root of this workspace's tree; `null` on a bot, task, or Surface chat workspace. */
    projectId: Nullable(cuid2Schema),
    /** Service shutdown barrier during archival; absent on older daemons. */
    serviceCleanup: Type.Optional(Nullable(workspaceServiceCleanupSchema)),
    /** `"archiving"` is the window where the decision is durable but cleanup runs. */
    status: Type.Union([
        Type.Literal("active"),
        Type.Literal("archiving"),
        Type.Literal("archived"),
    ]),
    /** The owning task, present only on a task's dedicated workspace. */
    taskId: Type.Optional(cuid2Schema),
    /** The owning Surface, present only on its dedicated chat workspace. */
    surfaceId: Type.Optional(surfaceIdSchema),
    /** The resident workspace-bound subtask; absent or null on other workspaces. */
    subtaskAgentId: Type.Optional(Nullable(cuid2Schema)),
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

/** Names the network an agent's connections leave from; opaque, compared only for equality. */
export const networkIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" });

/**
 * Which network an agent's connections leave from: this daemon's computer, one of its runners, or
 * a container of the agent's own. `"host"` is the daemon's computer, not necessarily the client's.
 */
export const agentNetworkKindSchema = Type.Union([
    Type.Literal("host"),
    Type.Literal("runner"),
    Type.Literal("container"),
]);
export type AgentNetworkKind = Static<typeof agentNetworkKindSchema>;

/** `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy`, protocol 28 or newer. */
export const workspaceAgentNetworkResponseSchema = Type.Object({
    networkId: networkIdSchema,
    /** Absent on older daemons; absent or a value this client does not know needs the tunnel. */
    kind: Type.Optional(agentNetworkKindSchema),
});
export type WorkspaceAgentNetworkResponse = Static<typeof workspaceAgentNetworkResponseSchema>;

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
