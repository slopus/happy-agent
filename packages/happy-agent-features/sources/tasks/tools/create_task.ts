import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksFeature } from "../TasksFeature.js";
import {
    taskSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskTitleSchema,
    type TaskCreateInput,
} from "../Task.js";

const taskToolCreateInputSchema = Type.Object(
    {
        title: taskTitleSchema,
        detail: Type.Optional(taskDetailSchema),
        priority: Type.Optional(taskPrioritySchema),
        dependsOn: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
    },
    { additionalProperties: false },
);

/** Create one durable task. The feature assigns and persists its retry identity. */
export function createTaskTool(tasks: TasksFeature, agentId: string) {
    return defineAgentTool({
        name: "create_task",
        description:
            "Create one persistent task in this agent's task list. The feature assigns a stable id so an interrupted call can be safely retried.",
        parameters: taskToolCreateInputSchema,
        returnType: Type.Object({ task: taskSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: TaskCreateInput) => ({
            task: await tasks.create(ctx, agentId, input),
        }),
        toLLM: ({ task }) => [
            {
                type: "text",
                text: `Task created: ${task.id}\n${task.title}`,
            },
        ],
    });
}
