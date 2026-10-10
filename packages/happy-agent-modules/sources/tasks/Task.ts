import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

export const taskStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
export const taskOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[0-9]+$",
});
export const taskVersionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const taskTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const taskPathSchema = Type.String({ minLength: 1, maxLength: 4_096 });
/** A human display name: nonblank, without control characters. */
export const taskNameSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
/** The immutable snake_case folder name chosen when a task is created. */
export const taskFolderNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});

/**
 * Durable state owned by the task catalog. The agent remains independently owned by Agent Base.
 *
 * A task is a bot without an avatar or administration: one persistent conversation in one
 * dedicated folder. It adds who it belongs to — the person whose message led to its creation —
 * and which agent created it.
 */
export const taskRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        name: taskNameSchema,
        /**
         * Whether the name was chosen rather than the placeholder. An unchosen name is replaced
         * once, from the task's first message; a rename settles it for good.
         */
        nameConfigured: Type.Boolean(),
        folderName: taskFolderNameSchema,
        /** The team user who owns the task; absent on a standalone installation. */
        ownerUserId: Type.Optional(cuid2Schema),
        /** The agent whose tool call created the task; absent when a person created it directly. */
        creatorAgentId: Type.Optional(cuid2Schema),
        workspaceId: cuid2Schema,
        workspaceVersion: taskVersionSchema,
        workspaceUpdatedAt: taskTimestampSchema,
        agentId: cuid2Schema,
        path: taskPathSchema,
        /** The runner the task's folder is on; absent when it is on this machine. */
        runnerId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" })),
        status: taskStatusSchema,
        version: taskVersionSchema,
        createdAt: taskTimestampSchema,
        updatedAt: taskTimestampSchema,
        archivedAt: Type.Optional(taskTimestampSchema),
    },
    { additionalProperties: false },
);

/** What an unnamed task is called until its first message names it. */
export const TASK_PLACEHOLDER_NAME = "New Task";

/** The member key of the one person a standalone installation belongs to. */
export const STANDALONE_TASK_MEMBER = "standalone";

/** Who a membership belongs to: a team user's ID, or the standalone installation's one person. */
export const taskMemberIdSchema = Type.Union([cuid2Schema, Type.Literal(STANDALONE_TASK_MEMBER)]);

/**
 * One person's place in one task. Joining puts a task in that person's list; the order key
 * places it there and belongs to that person alone, so reordering never moves anyone else's list.
 */
export const taskMembershipSchema = Type.Object(
    {
        taskId: cuid2Schema,
        memberId: taskMemberIdSchema,
        orderKey: taskOrderKeySchema,
        joinedAt: taskTimestampSchema,
    },
    { additionalProperties: false },
);

export const createTaskInputSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        workspaceId: Type.Optional(cuid2Schema),
        agentId: Type.Optional(cuid2Schema),
        /** Omitted, the task is the placeholder until its first message names it. */
        name: Type.Optional(taskNameSchema),
        folderName: Type.Optional(taskFolderNameSchema),
        ownerUserId: Type.Optional(cuid2Schema),
        creatorAgentId: Type.Optional(cuid2Schema),
        /** The opening message, delivered from `creatorAgentId` in the creating transaction. */
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
    },
    { additionalProperties: false },
);

export type TaskRecord = Static<typeof taskRecordSchema>;
export type TaskMemberId = Static<typeof taskMemberIdSchema>;
export type TaskMembership = Static<typeof taskMembershipSchema>;
export type TaskStatus = Static<typeof taskStatusSchema>;
export type CreateTaskInput = Static<typeof createTaskInputSchema>;
export const taskCreationSchema = Type.Object({ task: taskRecordSchema, created: Type.Boolean() });
export type TaskCreation = Static<typeof taskCreationSchema>;

export const archiveTaskCleanupSchema = Type.Object(
    { agentId: cuid2Schema },
    { additionalProperties: false },
);
export const TASK_ARCHIVE_FUNCTION = "tasks.archive";

export class TaskInputError extends Error {
    constructor(message = "The task request is invalid.") {
        super(message);
        this.name = "TaskInputError";
    }
}

export class TaskConflictError extends Error {
    readonly task: TaskRecord | undefined;

    constructor(message: string, task?: TaskRecord) {
        super(message);
        this.name = "TaskConflictError";
        this.task = task === undefined ? undefined : structuredClone(task);
    }
}

export class TaskNotFoundError extends Error {
    constructor(message = "The task was not found.") {
        super(message);
        this.name = "TaskNotFoundError";
    }
}
