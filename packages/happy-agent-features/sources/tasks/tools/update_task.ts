import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksFeature } from "../TasksFeature.js";
import {
    taskDetailSchema,
    taskPrioritySchema,
    taskIdSchema,
    taskSchema,
    taskStatusSchema,
    taskTitleSchema,
    type TaskUpdateInput,
} from "../Task.js";

const updateTaskInputSchema = Type.Object(
    {
        id: taskIdSchema,
        title: Type.Optional(taskTitleSchema),
        detail: Type.Optional(Type.Union([taskDetailSchema, Type.Null()])),
        priority: Type.Optional(taskPrioritySchema),
        status: Type.Optional(taskStatusSchema),
        dependsOn: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
    },
    { additionalProperties: false, minProperties: 2 },
);

/** Update one task while retaining its stable identity and ordering. */
export function updateTaskTool(tasks: TasksFeature, agentId: string) {
    return defineAgentTool({
        name: "update_task",
        description:
            "Update a task's title, detail, priority, status, or dependencies. Use complete_task when the task is finished.",
        parameters: updateTaskInputSchema,
        returnType: Type.Object({ task: taskSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id, ...changes }: { id: string } & TaskUpdateInput) => ({
            task: await tasks.update(ctx, agentId, id, changes),
        }),
        toLLM: ({ task }) => [
            {
                type: "text",
                text: `Task updated: ${task.id}\n${task.title}`,
            },
        ],
    });
}
