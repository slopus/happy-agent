/** Tasks: bot-like conversations for one piece of work, with an owner and per-person lists. */

import { type Static, Type } from "@sinclair/typebox";

import { agentSchema } from "./agents.js";
import {
    computeSchema,
    cuid2Schema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { userIdSchema } from "./userId.js";

/** A human display name: nonblank, bounded, and free of ASCII control characters. */
export const taskNameSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
export type TaskName = Static<typeof taskNameSchema>;

/** The immutable local folder name chosen when a task is created. */
export const taskFolderNameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});
export type TaskFolderName = Static<typeof taskFolderNameSchema>;

/** A task and its one independently versioned agent. Tasks have no avatar and no order. */
export const taskSchema = Type.Object({
    /** The task's one agent, embedded in full for list rendering. */
    agent: agentSchema,
    archivedAt: Nullable(timestampSchema),
    /**
     * Whether the caller may archive and unarchive the task. Caller-relative: absent from
     * `task.created` events and from daemons older than task archival routes.
     */
    canArchive: Type.Optional(Type.Boolean()),
    /** Mirrors the dedicated workspace's compute. */
    compute: computeSchema,
    createdAt: timestampSchema,
    /** The agent whose `create_task` call created the task. */
    creatorAgentId: Nullable(cuid2Schema),
    /** Immutable local snake_case folder name. */
    folderName: taskFolderNameSchema,
    id: cuid2Schema,
    name: taskNameSchema,
    /** The person the task belongs to; `null` in standalone mode or when nobody was identified. */
    ownerUserId: Nullable(userIdSchema),
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
    /** The task's dedicated workspace, distinct from the task and agent IDs. */
    workspaceId: cuid2Schema,
});
export type Task = Static<typeof taskSchema>;

/** One person's place in one task: joining puts the task in their own ordered list. */
export const taskMembershipSchema = Type.Object({
    joinedAt: timestampSchema,
    /** An opaque sort key within this member's own list. */
    orderKey: Type.String(),
    taskId: cuid2Schema,
    /** The member, or `null` for the one person of a standalone installation. */
    userId: Nullable(userIdSchema),
});
export type TaskMembership = Static<typeof taskMembershipSchema>;

/** `GET /v0/tasks` query: every task, or only the caller's joined tasks in the caller's order. */
export const taskListScopeSchema = Type.Union([Type.Literal("all"), Type.Literal("joined")]);
export type TaskListScope = Static<typeof taskListScopeSchema>;

/** `GET /v0/tasks` — `memberships` is always every membership of the caller, in their order. */
export const taskListResponseSchema = Type.Object({
    memberships: Type.Array(taskMembershipSchema),
    tasks: Type.Array(taskSchema),
});
export type TaskListResponse = Static<typeof taskListResponseSchema>;

/** Every single-task route answers with the task and the caller's membership in it. */
export const taskResponseSchema = Type.Object({
    membership: Nullable(taskMembershipSchema),
    task: taskSchema,
});
export type TaskResponse = Static<typeof taskResponseSchema>;

/** `POST /v0/tasks/:taskId/join` */
export const joinTaskRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type JoinTaskRequest = Static<typeof joinTaskRequestSchema>;

/** `POST /v0/tasks/:taskId/leave` */
export const leaveTaskRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type LeaveTaskRequest = Static<typeof leaveTaskRequestSchema>;

/** `POST /v0/tasks/:taskId/reorder` — moves the task within the caller's own list only. */
export const reorderTaskRequestSchema = Type.Object({
    /** The joined task to place this one after, or `null` to move it first. */
    afterId: Nullable(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderTaskRequest = Static<typeof reorderTaskRequestSchema>;

/** `POST /v0/tasks/:taskId/archive` — requires `If-Match`; the owner or team owner only. */
export const archiveTaskRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ArchiveTaskRequest = Static<typeof archiveTaskRequestSchema>;

/** `POST /v0/tasks/:taskId/unarchive` — requires `If-Match`; the owner or team owner only. */
export const unarchiveTaskRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type UnarchiveTaskRequest = Static<typeof unarchiveTaskRequestSchema>;
