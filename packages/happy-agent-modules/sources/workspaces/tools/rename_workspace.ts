import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceRenameToolInputSchema,
    workspaceSchema,
    type WorkspaceRenameToolInput,
} from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** Rename one owned workspace and move its Git branch with the name. */
export function renameWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "rename_workspace",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: ["rename workspace", "rename branch", "change worktree name"],
        description:
            "Rename one workspace you own. The name is the only name a workspace has, so the Git branch moves with it and the workspace is never renamed again by its first chat. Write a short title rather than a slug or a path.",
        parameters: workspaceRenameToolInputSchema,
        returnType: workspaceSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkspaceRenameToolInput, call) =>
            await workspaces.rename(ctx, { ...input, operationId: call.id }),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace renamed:", workspace),
            },
        ],
    });
}
