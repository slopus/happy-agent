import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { TasksModule } from "../TasksModule.js";

const sendTaskMessageInputSchema = Type.Object(
    {
        taskId: cuid2Schema,
        text: Type.String({ minLength: 1, maxLength: 100_000 }),
    },
    { additionalProperties: false },
);
type SendTaskMessageInput = Static<typeof sendTaskMessageInputSchema>;

/** Deliver one message into a task's conversation. */
export function sendTaskMessageTool(tasks: TasksModule, actingAgentId: string) {
    return defineAgentTool({
        name: "send_task_message",
        defer: true,
        capabilities: [
            "Create, list, message, and archive persistent tasks with their own folders.",
        ],
        searchKeywords: ["message task", "follow up task", "task conversation"],
        description: [
            "Send a message to a task by its ID. Find IDs with list_tasks.",
            "",
            "The message joins the task's one continuous conversation: an idle task starts working on it immediately, and a busy task picks it up when its current work ends. Delivery returns right away; any answer arrives as a message, so carry on with other work in the meantime.",
        ].join("\n"),
        parameters: sendTaskMessageInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SendTaskMessageInput, call) => {
            await tasks.sendMessage(ctx, actingAgentId, input.taskId, input.text, call.id);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Message delivered to the task. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ],
    });
}
