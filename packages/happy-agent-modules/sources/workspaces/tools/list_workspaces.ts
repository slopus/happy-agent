import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspacePageQuerySchema,
    workspacePageSchema,
    type WorkspacePageQuery,
} from "../WorkspacePage.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** List a bounded page of host-managed workspaces. */
export function listWorkspacesTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "list_workspaces",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: ["workspace catalog", "worktrees", "branches", "archived workspaces"],
        description:
            "List a bounded page of the persistent workspaces someone can still work in. Archived workspaces are history and are left out unless you pass includeArchived. Use nextCursor to continue reading the host catalog.",
        parameters: workspacePageQuerySchema,
        returnType: workspacePageSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: WorkspacePageQuery) => await workspaces.listPage(ctx, query),
        toLLM: (page) => [
            {
                type: "text",
                text: workspaces.formatPageForModel(page),
            },
        ],
    });
}
