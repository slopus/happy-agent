import { defineAgentTool } from "@slopus/happy-agent-base";

import { archiveSubtaskInputSchema } from "../Subtask.js";
import type { SubtasksModule } from "../SubtasksModule.js";

export function archiveSubtaskTool(subtasks: SubtasksModule, actingAgentId: string) {
    return defineAgentTool({
        name: "archive_subtask",
        defer: true,
        capabilities: [
            "Archive a direct subtask while preserving its workspace and conversation history.",
        ],
        searchKeywords: ["archive subtask", "finish task", "stop task"],
        description:
            "Archive one of your direct subtasks. Only its coordinating bot or subtask may do this. Stops the target's current work and running descendants, but marks only the target archived. Its workspace and conversation history remain; the user can restore it through the agent API. Repeating archival is harmless.",
        parameters: archiveSubtaskInputSchema,
        returnType: archiveSubtaskInputSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ agentId }) =>
            `archiving direct subtask "${agentId}" and stopping its current work and running descendants, while preserving its workspace and conversation history`,
        execute: async (ctx, input) => await subtasks.archive(ctx, actingAgentId, input.agentId),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Archived subtask ${agentId}. Its workspace and conversation history are preserved; descendants were stopped, not archived.`,
            },
        ],
    });
}
