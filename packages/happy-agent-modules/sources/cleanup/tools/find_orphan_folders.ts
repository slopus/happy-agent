import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { CleanupModule } from "../CleanupModule.js";
import { cleanupOrphanFoldersSchema } from "../CleanupSearch.js";

/** Folders under the Happy roots that nothing owns any more. Admin bots only. */
export function findOrphanFoldersTool(cleanup: CleanupModule, actingAgentId: string) {
    return defineAgentTool({
        name: "find_orphan_folders",
        defer: true,
        capabilities: [
            "Find, inspect, and clean up stale bots, tasks, subtasks, projects, workspaces, and folders on this installation.",
        ],
        searchKeywords: ["orphan folders", "leftover folders", "unused folders", "disk cleanup"],
        description:
            "List folders under this installation's Happy bot, task, workspace, and cloned-project folders, and the default runner's, that no bot, task, project, workspace, or agent names any more: leftovers of deleted or failed work. Surface folders are not checked. Check a folder with find_folder_owners before removing it; removing one is an ordinary, reviewed shell action. Only active admin bots may use it.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: cleanupOrphanFoldersSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await cleanup.orphanFoldersForAgent(ctx, actingAgentId),
        toLLM: ({ orphans, roots, truncated }) => {
            const where = (runnerId: string | undefined) =>
                runnerId === undefined ? "" : ` on runner ${runnerId}`;
            const lines = [
                orphans.length === 0
                    ? "No orphaned folders found."
                    : `${String(orphans.length)} orphaned ${orphans.length === 1 ? "folder" : "folders"}${truncated ? " (more exist; remove these and look again)" : ""}:`,
                ...orphans.map(
                    (orphan) => `- ${orphan.folder} (${orphan.root})${where(orphan.runnerId)}`,
                ),
                "Looked through:",
                ...roots.map(
                    (root) =>
                        `- ${root.folder} (${root.root})${where(root.runnerId)}${root.error === undefined ? "" : ` — could not be read: ${root.error}`}`,
                ),
            ];
            return [{ type: "text", text: lines.join("\n") }];
        },
    });
}
