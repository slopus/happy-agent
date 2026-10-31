import { taskChildSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    taskMemberIdSchema,
    taskMembershipSchema,
    taskRecordSchema,
    taskSectionRecordSchema,
    taskTimestampSchema,
} from "./Task.js";

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
            /** The task's child choices, oldest first, when one of them changed. */
            children: Type.Optional(Type.Array(taskChildSchema)),
        },
        { additionalProperties: false },
    ),
    /** An admin deleted the task for good; `task` is its last state. */
    Type.Object(
        { ...envelope, type: Type.Literal("task_deleted"), task: taskRecordSchema },
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
    /** A membership the member already held changed in place, such as being marked read. */
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("task_membership_updated"),
            membership: taskMembershipSchema,
        },
        { additionalProperties: false },
    ),
    /** The member's whole set of sections, in key order, after any change to it. */
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("task_sections_updated"),
            memberId: taskMemberIdSchema,
            sections: Type.Array(taskSectionRecordSchema),
        },
        { additionalProperties: false },
    ),
]);

export type TaskEvent = Static<typeof taskEventSchema>;
export type TaskEventListener = (ctx: Context, event: TaskEvent) => Promise<void> | void;
export type TaskUnsubscribe = () => void;
