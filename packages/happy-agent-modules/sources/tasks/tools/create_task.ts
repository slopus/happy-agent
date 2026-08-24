import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import {
    taskActiveFormSchema,
    taskSchema,
    taskDetailSchema,
    taskIdSchema,
    taskMetadataSchema,
    taskMutationErrorSchema,
    taskOwnerSchema,
    taskPrioritySchema,
    taskTitleSchema,
    TaskValidationError,
    type TaskCreateInput,
} from "../Task.js";

const taskToolCreateInputSchema = Type.Object(
    {
        activeForm: Type.Optional(taskActiveFormSchema),
        title: taskTitleSchema,
        detail: Type.Optional(taskDetailSchema),
        metadata: Type.Optional(taskMetadataSchema),
        owner: Type.Optional(taskOwnerSchema),
        priority: Type.Optional(taskPrioritySchema),
        dependsOn: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
    },
    { additionalProperties: false },
);

const createTaskToolResultSchema = Type.Union([
    Type.Object({ task: taskSchema }, { additionalProperties: false }),
    taskMutationErrorSchema,
]);

/** Create one durable task using the stable invocation ID as its task ID. */
export function createTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "create_task",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["add task", "create todo", "work item", "task dependency"],
        description: "Create one persistent task in this agent's task list.",
        parameters: taskToolCreateInputSchema,
        returnType: createTaskToolResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: TaskCreateInput, call) => {
            try {
                const task = await tasks.create(ctx, agentId, { ...input, id: call.id });
                return { task };
            } catch (error) {
                if (!(error instanceof TaskValidationError)) throw error;
                return { success: false, taskId: call.id, error: error.message };
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text: tasks.formatMutationForModel(
                    "task" in result
                        ? `Task created: ${result.task.id}\n${result.task.title}`
                        : `Task ${result.taskId} could not be created: ${result.error}`,
                ),
            },
        ],
    });
}
