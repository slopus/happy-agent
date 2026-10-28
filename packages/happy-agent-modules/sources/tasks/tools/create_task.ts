import { createId } from "@paralleldrive/cuid2";
import {
    DEFAULT_AGENT_PERMISSION_MODE,
    defineAgentTool,
    type AgentKV,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { formatHappyReferenceTag, type MessageMode } from "@slopus/happy-agent-client";

import {
    collaborationEffortSchema,
    collaborationServiceTierSchema,
    type CollaborationCreator,
    type CollaborationModule,
} from "../../collaboration/index.js";
import { narrowerPermissionMode } from "../../impl/delegatedPermissionMode.js";
import { TaskInputError, taskNameSchema, taskRecordSchema } from "../Task.js";
import type { TasksModule } from "../TasksModule.js";

const createTaskToolInputSchema = Type.Object(
    {
        name: Type.Optional(taskNameSchema),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        effort: Type.Optional(collaborationEffortSchema),
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
    },
    { additionalProperties: false },
);
type CreateTaskToolInput = Static<typeof createTaskToolInputSchema>;

/**
 * Create one persistent task: its folder, its one conversation, and its owner. A task an agent
 * opens runs in the product default mode, narrowed to `creatorPermissionMode`, the creating
 * agent's persistent mode, so delegating to a task never widens what the work may touch.
 */
export function createTaskTool(
    tasks: TasksModule,
    collaboration: CollaborationModule,
    actingAgentId: string,
    kv: AgentKV,
    creator: CollaborationCreator,
    creatorPermissionMode: AgentPermissionMode,
    options: string,
) {
    return defineAgentTool({
        name: "create_task",
        defer: true,
        capabilities: [
            "Create, list, message, and archive persistent tasks with their own folders.",
        ],
        searchKeywords: ["make a task", "new task", "create task", "task folder"],
        description: [
            "Create one persistent task: a user-visible conversation with its own dedicated folder, owned by the person you are working for. A task has no avatar; it can create its own subtasks for project work.",
            'Give it a short name such as "Fix login redirect"; prefer 2–3 words, 4 at most. Omit the name to let the task name itself from its first message. Put the details in text, which is delivered as the task\'s first message and starts its work. Omit text to create an idle task for the person to open.',
            "Returns the task without waiting. Talk to it later with send_task_message; there is no wait tool.",
            `Choose an optional model and effort; harness and provider default to yours when they serve the model.\n\n${options}\n\nCall agent_options for the current list.`,
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
            let mode: MessageMode | undefined;
            if (input.model !== undefined) {
                if (input.effort === undefined) {
                    throw new TaskInputError("Effort is required when a model is selected.");
                }
                const selection = collaboration.selectAgentModel(
                    {
                        model: input.model,
                        effort: input.effort,
                        ...(input.harness === undefined ? {} : { harness: input.harness }),
                        ...(input.provider === undefined ? {} : { provider: input.provider }),
                        ...(input.serviceTier === undefined
                            ? {}
                            : { serviceTier: input.serviceTier }),
                    },
                    creator,
                );
                mode = {
                    providerId: selection.provider,
                    modelId: selection.model,
                    effort: selection.effort,
                    serviceTier: selection.serviceTier ?? null,
                    permissionMode: narrowerPermissionMode(
                        DEFAULT_AGENT_PERMISSION_MODE,
                        creatorPermissionMode,
                    ),
                };
            } else if (
                input.effort !== undefined ||
                input.harness !== undefined ||
                input.provider !== undefined ||
                input.serviceTier !== undefined
            ) {
                throw new TaskInputError(
                    "A model must be selected to specify effort, harness, provider, or service tier.",
                );
            }
            return await tasks.create(ctx, {
                id: await call.kv.getOrCreate(ctx, "taskId", () => createId()),
                creatorAgentId: actingAgentId,
                ...(ownerUserId === undefined ? {} : { ownerUserId }),
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.text === undefined ? {} : { text: input.text }),
                ...(mode === undefined ? {} : { mode }),
            });
        },
        toLLM: (task) => [
            {
                type: "text",
                text: `Task created: ${task.name} — id ${task.id}, folder ${task.path}. Send it messages with send_task_message. Mention it in chat as ${formatHappyReferenceTag({ kind: "agent", id: task.agentId })}.`,
            },
        ],
    });
}
