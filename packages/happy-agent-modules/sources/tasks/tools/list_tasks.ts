import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import { taskPageQuerySchema, taskPageSchema, type TaskPageQuery } from "../TaskPage.js";

/** Read a bounded, deterministic task list. */
export function listTasksTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "list_tasks",
        defer: true,
        capabilities: ["Create, inspect, update, complete, and remove persistent tasks."],
        searchKeywords: ["task list", "todos", "work tracking", "task page"],
        description:
            "List a bounded page of this agent's persistent tasks in their current order. Follow nextOffset until all tasks are read.",
        parameters: taskPageQuerySchema,
        returnType: taskPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: TaskPageQuery) => await tasks.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: tasks.formatPageForModel(page),
            },
        ],
    });
}
