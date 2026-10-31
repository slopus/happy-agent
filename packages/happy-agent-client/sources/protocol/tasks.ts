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

/** An icon from Happy's icon library; clients show their default for an unknown type or slug. */
export const taskIconSchema = Type.Object({
    hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    slug: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    type: Type.Literal("library"),
});
export type TaskIcon = Static<typeof taskIconSchema>;

/** What may sit under a task's card. */
export const taskChildRefSchema = Type.Object({
    id: cuid2Schema,
    kind: Type.Union([Type.Literal("workspace"), Type.Literal("agent"), Type.Literal("artifact")]),
});
export type TaskChildRef = Static<typeof taskChildRefSchema>;
export type TaskChildKind = TaskChildRef["kind"];

/** Who made a change: an agent, Focus included, a person, or both `null` for the daemon. */
export const taskActorSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    userId: Nullable(userIdSchema),
});
export type TaskActor = Static<typeof taskActorSchema>;

export const taskChildVisibilitySchema = Type.Union([
    Type.Literal("shown"),
    Type.Literal("hidden"),
]);
export type TaskChildVisibility = Static<typeof taskChildVisibilitySchema>;

/** A choice about one child, shared by every member; no choice means the derived default. */
export const taskChildSchema = Type.Object({
    by: taskActorSchema,
    ref: taskChildRefSchema,
    updatedAt: timestampSchema,
    visibility: taskChildVisibilitySchema,
});
export type TaskChild = Static<typeof taskChildSchema>;

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
    /** Child choices, oldest first; absent without `capabilities.taskSections`. */
    children: Type.Optional(Type.Array(taskChildSchema, { maxItems: 200 })),
    /** Mirrors the dedicated workspace's compute. */
    compute: computeSchema,
    createdAt: timestampSchema,
    /** The agent whose `create_task` call created the task. */
    creatorAgentId: Nullable(cuid2Schema),
    /** Immutable local snake_case folder name. */
    folderName: taskFolderNameSchema,
    /** `null` until one is chosen; absent without `capabilities.taskSections`. */
    icon: Type.Optional(Nullable(taskIconSchema)),
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

/**
 * What the member has not looked at in a task: today only that an agent looped them in. The
 * reason set may grow; clients treat an unknown reason as plain unread.
 */
export const taskMembershipUnreadSchema = Type.Object({
    reason: Type.String({ minLength: 1, maxLength: 64 }),
    since: timestampSchema,
    /** The agent that looped the member in. */
    agentId: Type.Optional(cuid2Schema),
    /** The agent's one-sentence reason, shown to the member. */
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type TaskMembershipUnread = Static<typeof taskMembershipUnreadSchema>;

/** One person's place in one task: joining puts the task in their own ordered list. */
export const taskMembershipSchema = Type.Object({
    /** Out of the member's list but still in every response; absent means `false`. */
    hidden: Type.Optional(Type.Boolean()),
    joinedAt: timestampSchema,
    /** Set until the member reads the task; `null` when nothing is unread. Older daemons omit it. */
    unread: Type.Optional(Nullable(taskMembershipUnreadSchema)),
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

/** A section name: nonblank, bounded, free of control characters, unique per member ignoring case. */
export const taskSectionNameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

/**
 * A header in one member's list. Sections share the memberships' key space: a task belongs to the
 * last section whose key is below its own.
 */
export const taskSectionSchema = Type.Object({
    collapsed: Type.Boolean(),
    id: cuid2Schema,
    name: taskSectionNameSchema,
    orderKey: Type.String(),
});
export type TaskSection = Static<typeof taskSectionSchema>;

/** `GET /v0/tasks` — `memberships` is always every membership of the caller, in their order. */
export const taskListResponseSchema = Type.Object({
    memberships: Type.Array(taskMembershipSchema),
    /** The caller's sections in key order; absent without `capabilities.taskSections`. */
    sections: Type.Optional(Type.Array(taskSectionSchema)),
    tasks: Type.Array(taskSchema),
});
export type TaskListResponse = Static<typeof taskListResponseSchema>;

/** Every single-task route answers with the task and the caller's membership in it. */
export const taskResponseSchema = Type.Object({
    membership: Nullable(taskMembershipSchema),
    task: taskSchema,
});
export type TaskResponse = Static<typeof taskResponseSchema>;

/** `POST /v0/tasks` — a person creates a task, which they own and join. */
export const createTaskRequestSchema = Type.Object({
    /** The workspace and agent IDs name the new task's own, not existing entities. */
    agentId: Type.Optional(cuid2Schema),
    /** Omitted, the daemon derives a unique folder name from `name`, or from `task` without one. */
    folderName: Type.Optional(taskFolderNameSchema),
    /** The retry key: repeating it returns the existing task unchanged. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    /** Omitted, the task is `New Task` until it names itself from its first message. */
    name: Type.Optional(taskNameSchema),
    workspaceId: Type.Optional(cuid2Schema),
});
export type CreateTaskRequest = Static<typeof createTaskRequestSchema>;

/** `PATCH /v0/tasks/:taskId` — requires `If-Match`; the folder name never changes. */
export const renameTaskRequestSchema = Type.Object({
    /** Explicitly forbidden even though request objects tolerate future additive fields. */
    folderName: Type.Optional(Type.Never()),
    mutationId: Type.Optional(mutationIdSchema),
    name: taskNameSchema,
});
export type RenameTaskRequest = Static<typeof renameTaskRequestSchema>;

/**
 * `PATCH /v0/tasks/:taskId` with `capabilities.taskSections`: a name, an icon, or both. Each ends
 * its automatic choice for good.
 */
export const updateTaskRequestSchema = Type.Union([
    Type.Object({
        folderName: Type.Optional(Type.Never()),
        icon: Type.Optional(Nullable(taskIconSchema)),
        mutationId: Type.Optional(mutationIdSchema),
        name: taskNameSchema,
    }),
    Type.Object({
        folderName: Type.Optional(Type.Never()),
        icon: Nullable(taskIconSchema),
        mutationId: Type.Optional(mutationIdSchema),
        name: Type.Optional(taskNameSchema),
    }),
]);
export type UpdateTaskRequest = Static<typeof updateTaskRequestSchema>;

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
    /** Belongs to the other variant; exactly one anchor is present. */
    afterSectionId: Type.Optional(Type.Never()),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderTaskRequest = Static<typeof reorderTaskRequestSchema>;

/** `POST /v0/tasks/:taskId/reorder` with `capabilities.taskSections`: first in that section. */
export const reorderTaskAfterSectionRequestSchema = Type.Object({
    afterId: Type.Optional(Type.Never()),
    afterSectionId: cuid2Schema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderTaskAfterSectionRequest = Static<typeof reorderTaskAfterSectionRequestSchema>;

/** `PATCH /v0/tasks/:taskId/membership` — the caller's own membership; `taskSections`. */
export const updateTaskMembershipRequestSchema = Type.Object({
    hidden: Type.Boolean(),
    mutationId: Type.Optional(mutationIdSchema),
});
export type UpdateTaskMembershipRequest = Static<typeof updateTaskMembershipRequestSchema>;

/** Where a section header goes: the top, after a task, or after another section's last task. */
export const taskSectionAnchorSchema = Nullable(
    Type.Union([Type.Object({ taskId: cuid2Schema }), Type.Object({ sectionId: cuid2Schema })]),
);
export type TaskSectionAnchor = Static<typeof taskSectionAnchorSchema>;

/**
 * `PUT /v0/tasks/sections` — the caller's whole set, applied in order. A section left out is
 * removed; moving one with `after` takes its tasks along. Left out, `after` keeps an existing
 * section's place and puts a new one at the top.
 */
export const replaceTaskSectionsRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    sections: Type.Array(
        Type.Object({
            after: Type.Optional(taskSectionAnchorSchema),
            collapsed: Type.Boolean(),
            id: cuid2Schema,
            name: taskSectionNameSchema,
        }),
        { maxItems: 50 },
    ),
});
export type ReplaceTaskSectionsRequest = Static<typeof replaceTaskSectionsRequestSchema>;

/** `PUT /v0/tasks/sections` */
export const taskSectionsResponseSchema = Type.Object({
    sections: Type.Array(taskSectionSchema),
});
export type TaskSectionsResponse = Static<typeof taskSectionsResponseSchema>;

/** `PUT /v0/tasks/:taskId/children/:kind/:refId` — shared by every member; the latest wins. */
export const setTaskChildRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    visibility: taskChildVisibilitySchema,
});
export type SetTaskChildRequest = Static<typeof setTaskChildRequestSchema>;

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
