import { Type, type Static } from "@sinclair/typebox";

/** Stable identifiers used for tasks and their dependencies. */
export const taskIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
});

/** The small lifecycle a task can have. */
export const taskStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
]);

/** How prominently a task should be shown. */
export const taskPrioritySchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("normal"),
    Type.Literal("high"),
]);

/** A bounded title suitable for both a model context and a protocol response. */
export const taskTitleSchema = Type.String({
    minLength: 1,
    maxLength: 500,
});

/** Optional detail carried with a task. */
export const taskDetailSchema = Type.String({
    maxLength: 4_000,
});

/** Milliseconds since the Unix epoch. */
export const taskTimestampSchema = Type.Integer({
    minimum: 0,
});

/** A task as it is stored in the agent's feature KV. */
export const taskSchema = Type.Object(
    {
        id: taskIdSchema,
        title: taskTitleSchema,
        detail: Type.Optional(taskDetailSchema),
        status: taskStatusSchema,
        priority: taskPrioritySchema,
        dependsOn: Type.Array(taskIdSchema, {
            maxItems: 64,
            uniqueItems: true,
        }),
        createdAt: taskTimestampSchema,
        updatedAt: taskTimestampSchema,
        ordering: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

/** A task that can be created through the public feature API. */
export const taskCreateInputSchema = Type.Object(
    {
        id: Type.Optional(taskIdSchema),
        title: taskTitleSchema,
        detail: Type.Optional(taskDetailSchema),
        priority: Type.Optional(taskPrioritySchema),
        dependsOn: Type.Optional(
            Type.Array(taskIdSchema, {
                maxItems: 64,
                uniqueItems: true,
            }),
        ),
    },
    { additionalProperties: false },
);

/** A partial task change. `null` deliberately means remove the stored detail. */
export const taskUpdateInputSchema = Type.Object(
    {
        title: Type.Optional(taskTitleSchema),
        detail: Type.Optional(Type.Union([taskDetailSchema, Type.Null()])),
        priority: Type.Optional(taskPrioritySchema),
        status: Type.Optional(taskStatusSchema),
        dependsOn: Type.Optional(
            Type.Array(taskIdSchema, {
                maxItems: 64,
                uniqueItems: true,
            }),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);

export type TaskId = Static<typeof taskIdSchema>;
export type TaskStatus = Static<typeof taskStatusSchema>;
export type TaskPriority = Static<typeof taskPrioritySchema>;
export type Task = Static<typeof taskSchema>;
export type TaskCreateInput = Static<typeof taskCreateInputSchema>;
export type TaskUpdateInput = Static<typeof taskUpdateInputSchema>;
