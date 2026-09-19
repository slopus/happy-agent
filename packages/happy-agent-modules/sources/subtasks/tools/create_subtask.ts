import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { createSubtaskInputSchema, subtaskResultSchema } from "../Subtask.js";
import type { SubtasksModule } from "../SubtasksModule.js";

export function createSubtaskTool(subtasks: SubtasksModule, agentId: string, providerId: string) {
    return defineAgentTool({
        name: "create_subtask",
        defer: true,
        capabilities: [
            "Create user-interactive subtasks for a bot, sharing its folder or using a new project workspace.",
        ],
        searchKeywords: ["subtask", "delegate task", "project task", "workspace task"],
        description: [
            "Create a user-visible subtask you coordinate. Only bots and subtasks may create one; depth is limited to two levels below a bot, not two siblings.",
            "Reserve subtasks for substantial, distinct workstreams, such as changes across projects; handle small steps inline. Usually create second-level subtasks only on explicit user request. Honor explicit subtask requests; use create_agent for internal research.",
            "Sidebar title: prefer 2–3 words; 4 at most, as a last resort. Put details in text.",
            "Omit workspace to share your filesystem, or supply workspace with projectId and a short name for a new workspace. Work starts after setup.",
            "Returns the agent ID without waiting. Coordinate via send_agent_message and archive direct subtasks with archive_subtask. Users can message, archive, or restore them. There is no wait tool.",
            "Choose a model and effort. Omitting provider uses your current provider when it offers that model.",
            subtasks.modelDescription(),
        ].join("\n\n"),
        parameters: createSubtaskInputSchema,
        returnType: subtaskResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input, call) =>
            await subtasks.create(
                ctx,
                agentId,
                input,
                await call.kv.getOrCreate(ctx, "agentId", () => createId()),
                input.workspace === undefined
                    ? undefined
                    : await call.kv.getOrCreate(ctx, "workspaceId", () => createId()),
                providerId,
            ),
        toLLM: (result) => [
            {
                type: "text",
                text: `Created subtask ${result.agentId}${result.workspaceId === undefined ? " sharing your filesystem" : ` in workspace ${result.workspaceId}`}. It runs independently; use send_agent_message to coordinate with it.`,
            },
        ],
    });
}
