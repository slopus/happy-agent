import { defineAgentTool } from "@slopus/happy-agent-base";

import { archiveSubtaskInputSchema } from "../Subtask.js";
import type { SubtasksModule } from "../SubtasksModule.js";

export function archiveSubtaskTool(subtasks: SubtasksModule, actingAgentId: string) {
    return defineAgentTool({
        name: "archive_subtask",
        defer: true,
        capabilities: [
            "Archive a direct subtask together with its own workspace, preserving conversation history.",
        ],
        searchKeywords: ["archive subtask", "finish task", "stop task"],
        description:
            "Archive one of your direct subtasks. Only its coordinating bot or subtask may do this. Stops the target's current work and running descendants, but marks only the target archived. A workspace-bound subtask's workspace is archived with it; a shared-filesystem subtask leaves the shared folder untouched. Conversation history remains, but archival is final: nobody can restore the subtask. Repeating archival is harmless.",
        parameters: archiveSubtaskInputSchema,
        returnType: archiveSubtaskInputSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ agentId }) =>
            `archiving direct subtask "${agentId}" together with its own workspace, if it has one, and stopping its current work and running descendants, while preserving its conversation history`,
        execute: async (ctx, input) => await subtasks.archive(ctx, actingAgentId, input.agentId),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Archived subtask ${agentId} together with its own workspace, if it had one. Its conversation history is preserved; descendants were stopped, not archived.`,
            },
        ],
    });
}
