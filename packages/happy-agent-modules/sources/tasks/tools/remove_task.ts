import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { taskIdSchema, taskMutationErrorSchema, TaskValidationError } from "../Task.js";
import type { TasksModule } from "../TasksModule.js";

const removeTaskInputSchema = Type.Object({ id: taskIdSchema }, { additionalProperties: false });

const removeTaskResultSchema = Type.Union([
    Type.Object(
        {
            removed: Type.Literal(true),
            taskId: taskIdSchema,
        },
        { additionalProperties: false },
    ),
    taskMutationErrorSchema,
]);

/** Remove one task and unlink its dependency edges. */
export function removeTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "remove_task",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["delete task", "remove todo", "discard work item"],
        description:
            "Remove an obsolete task from this agent's persistent task list and unlink its dependencies.",
        parameters: removeTaskInputSchema,
        returnType: removeTaskResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }) => {
            try {
                const removed = await tasks.remove(ctx, agentId, id);
                return removed
                    ? { removed: true, taskId: id }
                    : {
                          success: false,
                          taskId: id,
                          error: `Task "${id}" does not exist.`,
                      };
            } catch (error) {
                if (!(error instanceof TaskValidationError)) throw error;
                return { success: false, taskId: id, error: error.message };
            }
        },
        toLLM: (result) => [
            {
                type: "text",
                text: tasks.formatMutationForModel(
                    "removed" in result
                        ? `Task removed: ${result.taskId}`
                        : `Task ${result.taskId} could not be removed: ${result.error}`,
                ),
            },
        ],
    });
}
