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
        searchKeywords: ["archive subtask", "finish subtask", "stop subtask"],
        description:
            "Archive one of your direct subtasks. Only its coordinating bot, task, or subtask may do this. Stops the target's current work and running descendants, but marks only the target archived. A workspace-bound subtask's workspace is archived with it and its worktree folder is removed in the background: the worktree's branch is kept, and any uncommitted or untracked work is first saved as a commit at refs/happy/archived/<workspace ID> in the project's repository. A shared-filesystem subtask leaves the shared folder untouched. Conversation history remains, but archival is final: nobody can restore the subtask. Repeating archival is harmless.",
        parameters: archiveSubtaskInputSchema,
        returnType: archiveSubtaskInputSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ agentId }) =>
            `archiving direct subtask "${agentId}" together with its own workspace, if it has one, and stopping its current work and running descendants, while preserving its conversation history; a removed worktree keeps its branch, and its uncommitted or untracked work is saved to a Git ref first`,
        execute: async (ctx, input) => await subtasks.archive(ctx, actingAgentId, input.agentId),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Archived subtask ${agentId} together with its own workspace, if it had one. Its conversation history is preserved; descendants were stopped, not archived. If its workspace was a worktree, its branch is kept, and any uncommitted or untracked work is saved as a commit at refs/happy/archived/<workspace ID> in the project's repository before the folder is removed. Recover it with \`git switch -c <new-branch> refs/happy/archived/<workspace ID>\`.`,
            },
        ],
    });
}
