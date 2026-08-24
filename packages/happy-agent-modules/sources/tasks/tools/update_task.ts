import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import {
    taskActiveFormSchema,
    taskDetailSchema,
    taskPrioritySchema,
    taskIdSchema,
    taskMetadataPatchSchema,
    taskMutationErrorSchema,
    taskOwnerSchema,
    taskSchema,
    taskStatusSchema,
    taskTitleSchema,
    TaskValidationError,
    type TaskUpdateInput,
} from "../Task.js";

const updateTaskInputSchema = Type.Object(
    {
        id: taskIdSchema,
        activeForm: Type.Optional(Type.Union([taskActiveFormSchema, Type.Null()])),
        title: Type.Optional(taskTitleSchema),
        detail: Type.Optional(Type.Union([taskDetailSchema, Type.Null()])),
        metadata: Type.Optional(taskMetadataPatchSchema),
        owner: Type.Optional(Type.Union([taskOwnerSchema, Type.Null()])),
        priority: Type.Optional(taskPrioritySchema),
        status: Type.Optional(Type.Union([taskStatusSchema, Type.Literal("deleted")])),
        dependsOn: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
        addBlocks: Type.Optional(Type.Array(taskIdSchema, { maxItems: 500, uniqueItems: true })),
        addBlockedBy: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
        removeBlocks: Type.Optional(Type.Array(taskIdSchema, { maxItems: 500, uniqueItems: true })),
        removeBlockedBy: Type.Optional(
            Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true }),
        ),
    },
    { additionalProperties: false, minProperties: 2 },
);
type UpdateTaskToolInput = Static<typeof updateTaskInputSchema>;

const updateTaskToolResultSchema = Type.Union([
    Type.Object({ task: taskSchema }, { additionalProperties: false }),
    Type.Object(
        { removed: Type.Literal(true), taskId: taskIdSchema },
        { additionalProperties: false },
    ),
    taskMutationErrorSchema,
]);

/** Update one task while retaining its stable identity and ordering. */
export function updateTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "update_task",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["edit task", "change task status", "assign work", "task dependencies"],
        description:
            "Update a task's title, detail, assignment, metadata, status, or dependencies. Use complete_task when the task is finished; use deleted status to remove it.",
        parameters: updateTaskInputSchema,
        returnType: updateTaskToolResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id, ...changes }: UpdateTaskToolInput) => {
            try {
                if (changes.status === "deleted") {
                    const removed = await tasks.remove(ctx, agentId, id);
                    return removed
                        ? { removed: true, taskId: id }
                        : {
                              success: false,
                              taskId: id,
                              error: `Task "${id}" does not exist.`,
                              updatedFields: [] as string[],
                          };
                }
                const task = await tasks.update(ctx, agentId, id, changes as TaskUpdateInput);
                return { task };
            } catch (error) {
                if (!(error instanceof TaskValidationError)) throw error;
                return {
                    success: false,
                    taskId: id,
                    error: error.message,
                    updatedFields: [] as string[],
                };
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text: tasks.formatMutationForModel(
                    "task" in result
                        ? `Task updated: ${result.task.id}\n${result.task.title}`
                        : "removed" in result
                          ? `Task removed: ${result.taskId}`
                          : `Task ${result.taskId} could not be updated: ${result.error}`,
                ),
            },
        ],
    });
}
