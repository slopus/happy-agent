import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { CleanupModule } from "../CleanupModule.js";
import { cleanupDeletionPlanSchema } from "../CleanupDeletion.js";
import { cleanupItemKindSchema } from "../CleanupSearch.js";
import { formatCleanupPlan } from "../impl/formatCleanupPlan.js";

const deletePermanentlyInputSchema = Type.Object(
    {
        kind: cleanupItemKindSchema,
        id: Type.String({
            minLength: 1,
            maxLength: 128,
            description: "The bot, task, project, or workspace ID; a subtask's is its agent ID.",
        }),
        confirmation: Type.String({
            minLength: 1,
            maxLength: 64,
            description: "The confirmation code preview_delete returned for this exact deletion.",
        }),
    },
    { additionalProperties: false },
);
type DeletePermanentlyInput = Static<typeof deletePermanentlyInputSchema>;

/** Permanently deletes one previewed item and everything it takes with it. Admin bots only. */
export function deletePermanentlyTool(cleanup: CleanupModule, actingAgentId: string) {
    return defineAgentTool({
        name: "delete_permanently",
        defer: true,
        capabilities: [
            "Find, inspect, and clean up stale bots, tasks, subtasks, projects, workspaces, and folders on this installation.",
        ],
        searchKeywords: ["delete permanently", "purge", "hard delete", "remove forever"],
        description:
            "Permanently delete one bot, task, subtask, project, or workspace, active or archived, with everything preview_delete listed for it: agents and their whole conversations, catalog rows, folders, and worktree branches. Pass the confirmation code from preview_delete; if anything changed since, the call is refused and you must preview again. Running work is stopped at once and the removal finishes in the background. This cannot be undone. Only active admin bots may use it, and never on themselves or anything they run inside.",
        parameters: deletePermanentlyInputSchema,
        returnType: cleanupDeletionPlanSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ kind, id }: DeletePermanentlyInput) =>
            `permanently deleting ${kind} "${id}" with every agent, conversation, folder, and worktree branch that belongs to it, which cannot be undone`,
        execute: async (ctx, { kind, id, confirmation }: DeletePermanentlyInput) =>
            await cleanup.deleteForAgent(ctx, actingAgentId, { kind, id }, confirmation),
        toLLM: (plan) => [
            {
                type: "text",
                text: `${formatCleanupPlan(
                    plan,
                    `Deleting ${plan.target.kind} ${JSON.stringify(plan.target.name)}. Its work has been stopped and it is out of every active list; the rest is being removed in the background:`,
                )}\n\nCheck with search_instance or find_folder_owners that it is gone.`,
            },
        ],
    });
}
