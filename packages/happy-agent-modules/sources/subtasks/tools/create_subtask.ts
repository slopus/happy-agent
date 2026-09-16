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
            "Create a user-visible subtask managed by you. Only a bot or another subtask may create one, with at most two subtask levels below a bot; multiple siblings are allowed.",
            "Omit workspace to share your filesystem. Supply workspace with a projectId and a short human-readable name to create a new ordinary workspace in that project. Work starts after workspace setup finishes.",
            "This returns the new agent's ID without waiting for its work. Use send_agent_message for follow-ups. The user may open it, send messages, and archive it through the agent API. There is no wait tool.",
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
