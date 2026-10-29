import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CleanupModule } from "../CleanupModule.js";
import { cleanupDeletionPlanSchema, cleanupDeletionTargetSchema } from "../CleanupDeletion.js";
import { formatCleanupPlan } from "../impl/formatCleanupPlan.js";

/** Everything deleting one item would remove, without removing anything. Admin bots only. */
export function previewDeleteTool(cleanup: CleanupModule, actingAgentId: string) {
    return defineAgentTool({
        name: "preview_delete",
        defer: true,
        capabilities: [
            "Find, inspect, and clean up stale bots, tasks, subtasks, projects, workspaces, and folders on this installation.",
        ],
        searchKeywords: ["preview delete", "dry run delete", "what would be deleted", "purge"],
        description:
            "Preview permanently deleting one bot, task, subtask, project, or workspace without changing anything. Lists every item it takes with it, every agent whose conversation would be erased (hidden subagents included, with running ones flagged), every folder and Git branch removed, and registered project folders that are kept. Returns the confirmation code delete_permanently needs. A deletion that would reach you or anything you run inside is refused. Only active admin bots may use it.",
        parameters: cleanupDeletionTargetSchema,
        returnType: cleanupDeletionPlanSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, target) => await cleanup.previewForAgent(ctx, actingAgentId, target),
        toLLM: (plan) => [
            {
                type: "text",
                text: `${formatCleanupPlan(
                    plan,
                    `Deleting ${plan.target.kind} ${JSON.stringify(plan.target.name)} would permanently remove the following. Nothing has been changed.`,
                )}\n\nTo carry this out, call delete_permanently with confirmation "${plan.confirmation}". Deletion cannot be undone; conversations are erased too.`,
            },
        ],
    });
}
