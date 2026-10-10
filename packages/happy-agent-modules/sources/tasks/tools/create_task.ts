import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool, type AgentKV } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { taskNameSchema, taskRecordSchema } from "../Task.js";
import type { TasksModule } from "../TasksModule.js";

const createTaskToolInputSchema = Type.Object(
    {
        name: taskNameSchema,
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
    },
    { additionalProperties: false },
);
type CreateTaskToolInput = Static<typeof createTaskToolInputSchema>;

/** Create one persistent task: its folder, its one conversation, and its owner. */
export function createTaskTool(tasks: TasksModule, actingAgentId: string, kv: AgentKV) {
    return defineAgentTool({
        name: "create_task",
        defer: true,
        capabilities: [
            "Create, list, message, and archive persistent tasks with their own folders.",
        ],
        searchKeywords: ["make a task", "new task", "create task", "task folder"],
        description: [
            "Create one persistent task: a user-visible conversation with its own dedicated folder, owned by the person you are working for. A task has no avatar; it can create its own subtasks for project work.",
            'Give it a short name such as "Fix login redirect"; prefer 2–3 words, 4 at most. Put the details in text, which is delivered as the task\'s first message and starts its work. Omit text to create an idle task for the person to open.',
            "Returns the task without waiting. Talk to it later with send_task_message; there is no wait tool.",
        ].join("\n\n"),
        parameters: createTaskToolInputSchema,
        returnType: taskRecordSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        // A task outlives the call that made it, so its identity is minted once and remembered in
        // this invocation's own store. A repeated call after an interruption finds the task it
        // already created instead of minting a duplicate.
        execute: async (ctx, input: CreateTaskToolInput, call) => {
            const ownerUserId = await tasks.ownerFor(ctx, kv);
            return await tasks.create(ctx, {
                ...input,
                id: await call.kv.getOrCreate(ctx, "taskId", () => createId()),
                creatorAgentId: actingAgentId,
                ...(ownerUserId === undefined ? {} : { ownerUserId }),
            });
        },
        toLLM: (task) => [
            {
                type: "text",
                text: `Task created: ${task.name} — id ${task.id}, folder ${task.path}. Send it messages with send_task_message.`,
            },
        ],
    });
}
