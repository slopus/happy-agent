import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import { taskIdSchema, taskMutationErrorSchema, taskSchema, TaskValidationError } from "../Task.js";

const completeTaskInputSchema = Type.Object({ id: taskIdSchema }, { additionalProperties: false });

const completeTaskResultSchema = Type.Union([
    Type.Object({ task: taskSchema }, { additionalProperties: false }),
    taskMutationErrorSchema,
]);

/** Mark one task complete. Repeating this call returns the same task. */
export function completeTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "complete_task",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["finish task", "mark todo complete", "complete work item"],
        description: "Mark a task completed after its work has been finished and verified.",
        parameters: completeTaskInputSchema,
        returnType: completeTaskResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }) => {
            try {
                const task = await tasks.complete(ctx, agentId, id);
                return { task };
            } catch (error) {
                // Naming a task that is not there is an ordinary answer to give a model, not a
                // tool failure: it can read the list and try again.
                if (!(error instanceof TaskValidationError)) throw error;
                return { success: false, taskId: id, error: error.message };
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text: tasks.formatMutationForModel(
                    "task" in result
                        ? `Task completed: ${result.task.id}\n${result.task.title}`
                        : `Task ${result.taskId} could not be completed: ${result.error}`,
                ),
            },
        ],
    });
}
