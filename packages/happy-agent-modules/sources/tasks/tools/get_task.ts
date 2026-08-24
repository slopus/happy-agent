import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import { taskIdSchema } from "../Task.js";
import {
    taskDetailPageSchema,
    taskDetailQuerySchema,
    type TaskDetailQuery,
} from "../TaskDetailPage.js";

const getTaskInputSchema = Type.Object(
    {
        id: taskIdSchema,
        ...taskDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

/** Read one complete task, including bounded detail and dependencies. */
export function getTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "get_task",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["inspect task", "task detail", "task dependencies"],
        description:
            "Read one persistent task by id. Follow detail and dependency offsets to inspect long detail or dependency lists.",
        parameters: getTaskInputSchema,
        returnType: taskDetailPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id, ...query }: { id: string } & TaskDetailQuery) =>
            await tasks.getPage(ctx, agentId, id, query),
        toLLM: (page) => [
            {
                type: "text",
                text: tasks.formatDetailPageForModel(page),
            },
        ],
    });
}
