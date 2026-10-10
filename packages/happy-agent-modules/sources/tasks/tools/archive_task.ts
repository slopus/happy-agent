import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { taskRecordSchema } from "../Task.js";
import type { TasksModule } from "../TasksModule.js";

const archiveTaskInputSchema = Type.Object(
    { taskId: cuid2Schema },
    { additionalProperties: false },
);
type ArchiveTaskInput = Static<typeof archiveTaskInputSchema>;

/** Archive a task this agent created, keeping its folder and history. */
export function archiveTaskTool(tasks: TasksModule, actingAgentId: string) {
    return defineAgentTool({
        name: "archive_task",
        defer: true,
        capabilities: [
            "Create, list, message, and archive persistent tasks with their own folders.",
        ],
        searchKeywords: ["archive task", "finish task", "close task"],
        description:
            "Archive a task you created. Stops its current work and running descendants, ends its background processes, and archives its conversation. Its folder stays on disk and its history stays readable. Repeating archival is harmless.",
        parameters: archiveTaskInputSchema,
        returnType: taskRecordSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ taskId }) =>
            `archiving task "${taskId}", stopping its current work, running descendants, and background processes, while keeping its folder and conversation history`,
        execute: async (ctx, input: ArchiveTaskInput) =>
            await tasks.archiveForAgent(ctx, actingAgentId, input.taskId),
        toLLM: (task) => [
            {
                type: "text",
                text: `Archived task ${task.name} (${task.id}). Its folder ${task.path} and conversation history are kept.`,
            },
        ],
    });
}
