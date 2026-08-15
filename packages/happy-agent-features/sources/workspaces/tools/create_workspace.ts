import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceCreateToolInputSchema,
    workspaceSchema,
    type WorkspaceCreateToolInput,
} from "../Workspace.js";
import type { WorkspacesFeature } from "../WorkspacesFeature.js";

/** Create one host-managed workspace with a feature-owned durable retry identity. */
export function createWorkspaceTool(workspaces: WorkspacesFeature, agentId: string) {
    return defineAgentTool({
        name: "create_workspace",
        description:
            "Create one persistent workspace for isolated work. The result includes complete project, base, owner, status, and timestamp detail; follow its detail cursor with get_workspace when the model-output budget requires another page. The host owns its worktree, Git, filesystem, and path policy; the feature assigns a stable identity so an interrupted call can be retried safely.",
        parameters: workspaceCreateToolInputSchema,
        returnType: workspaceSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkspaceCreateToolInput) =>
            await workspaces.create(ctx, agentId, input),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace created:", workspace),
            },
        ],
    });
}
