import { Type, type Static } from "@sinclair/typebox";

import { taskIdSchema, taskSchema } from "./Task.js";

const MAX_TASK_DETAIL_PAGE = 1_024;
const MAX_TASK_DEPENDENCY_PAGE = 64;

/** The bounded slices used when a model reads one task in multiple calls. */
export const taskDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_000 })),
        detailLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_DETAIL_PAGE })),
        dependencyOffset: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_TASK_DEPENDENCY_PAGE }),
        ),
        dependencyLimit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_TASK_DEPENDENCY_PAGE }),
        ),
    },
    { additionalProperties: false },
);

const taskDetailResultSchema = Type.Object(
    {
        task: taskSchema,
        detail: Type.String({ maxLength: MAX_TASK_DETAIL_PAGE }),
        detailOffset: Type.Integer({ minimum: 0, maximum: 4_000 }),
        detailTotal: Type.Integer({ minimum: 0, maximum: 4_000 }),
        nextDetailOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_000 })),
        dependencies: Type.Array(taskIdSchema, {
            maxItems: MAX_TASK_DEPENDENCY_PAGE,
        }),
        dependencyOffset: Type.Integer({
            minimum: 0,
            maximum: MAX_TASK_DEPENDENCY_PAGE,
        }),
        dependencyTotal: Type.Integer({
            minimum: 0,
            maximum: MAX_TASK_DEPENDENCY_PAGE,
        }),
        nextDependencyOffset: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_TASK_DEPENDENCY_PAGE }),
        ),
    },
    { additionalProperties: false },
);

/** A bounded task lookup result, or a stable empty result for an unknown ID. */
export const taskDetailPageSchema = Type.Union([
    taskDetailResultSchema,
    Type.Object({ task: Type.Null() }, { additionalProperties: false }),
]);

export type TaskDetailQuery = Static<typeof taskDetailQuerySchema>;
export type TaskDetailPage = Static<typeof taskDetailPageSchema>;

export const MAX_TASK_DETAIL_PAGE_SIZE = MAX_TASK_DETAIL_PAGE;
export const MAX_TASK_DEPENDENCY_PAGE_SIZE = MAX_TASK_DEPENDENCY_PAGE;
