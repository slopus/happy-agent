import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { taskMembershipSchema, taskRecordSchema, taskTimestampSchema } from "./Task.js";

const envelope = {
    eventId: Type.String({ minLength: 1, maxLength: 128 }),
    at: taskTimestampSchema,
} as const;

export const taskEventSchema = Type.Union([
    Type.Object(
        { ...envelope, type: Type.Literal("task_created"), task: taskRecordSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("task_updated"),
            task: taskRecordSchema,
            previousTask: taskRecordSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("task_joined"), membership: taskMembershipSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("task_reordered"), membership: taskMembershipSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("task_left"), membership: taskMembershipSchema },
        { additionalProperties: false },
    ),
]);

export type TaskEvent = Static<typeof taskEventSchema>;
export type TaskEventListener = (ctx: Context, event: TaskEvent) => Promise<void> | void;
export type TaskUnsubscribe = () => void;
