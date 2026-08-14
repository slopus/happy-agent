import { Type, type Static } from "@sinclair/typebox";

import { taskSchema } from "./Task.js";

/** The bounded page request used by public callers and the list_tasks tool. */
export const taskPageQuerySchema = Type.Object(
    {
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
);

/** A page of tasks with enough metadata for a model to continue reading. */
export const taskPageSchema = Type.Object(
    {
        tasks: Type.Array(taskSchema, { maxItems: 100 }),
        offset: Type.Integer({ minimum: 0 }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        total: Type.Integer({ minimum: 0, maximum: 500 }),
        nextOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
    },
    { additionalProperties: false },
);

export type TaskPageQuery = Static<typeof taskPageQuerySchema>;
export type TaskPage = Static<typeof taskPageSchema>;
