import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { CleanupModule } from "../CleanupModule.js";
import { cleanupFolderOwnersSchema, type CleanupFolderRelation } from "../CleanupSearch.js";
import { formatCleanupAgent, formatCleanupItem } from "../impl/formatCleanupItem.js";

const findFolderOwnersInputSchema = Type.Object(
    {
        folder: Type.String({
            minLength: 1,
            maxLength: 4_096,
            pattern: "^/",
            description: "An absolute folder path.",
        }),
    },
    { additionalProperties: false },
);
type FindFolderOwnersInput = Static<typeof findFolderOwnersInputSchema>;

const RELATION_HEADINGS: Record<CleanupFolderRelation, string> = {
    same: "This folder",
    contains: "Holding this folder",
    inside: "Inside this folder",
};

/** Which bots, tasks, subtasks, projects, workspaces, and agents use one folder. Admin bots only. */
export function findFolderOwnersTool(cleanup: CleanupModule, actingAgentId: string) {
    return defineAgentTool({
        name: "find_folder_owners",
        defer: true,
        capabilities: [
            "Find, inspect, and clean up stale bots, tasks, subtasks, projects, workspaces, and folders on this installation.",
        ],
        searchKeywords: [
            "folder owner",
            "which task uses folder",
            "who uses this folder",
            "session folder",
        ],
        description:
            "Find what owns or works in a folder: the bots, tasks, subtasks, projects, and workspaces whose folder it is, holds it, or lies inside it, and every agent working there, hidden subagents included, each with whether it is running, idle, or archived. Use it to tell whether a folder is still in use before removing anything. Only active admin bots may use it.",
        parameters: findFolderOwnersInputSchema,
        returnType: cleanupFolderOwnersSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { folder }: FindFolderOwnersInput) =>
            await cleanup.folderOwnersForAgent(ctx, actingAgentId, folder),
        toLLM: (owners) => {
            if (owners.items.length === 0 && owners.agents.length === 0) {
                return [
                    {
                        type: "text",
                        text: `Nothing on this installation owns or works in ${owners.folder}.`,
                    },
                ];
            }
            const lines = [`Folder ${owners.folder}:`];
            for (const relation of ["same", "contains", "inside"] as const) {
                const items = owners.items.filter((owner) => owner.relation === relation);
                const agents = owners.agents.filter((owner) => owner.relation === relation);
                if (items.length === 0 && agents.length === 0) continue;
                lines.push(`${RELATION_HEADINGS[relation]}:`);
                lines.push(...items.map(({ item }) => formatCleanupItem(item, owners.at)));
                if (agents.length > 0) {
                    lines.push("Agents:");
                    lines.push(...agents.map(({ agent }) => formatCleanupAgent(agent, owners.at)));
                }
            }
            return [{ type: "text", text: lines.join("\n") }];
        },
    });
}
