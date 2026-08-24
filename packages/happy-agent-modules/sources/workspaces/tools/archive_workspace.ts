import { defineAgentTool } from "@slopus/happy-agent-base";

import { workspaceIdSchema, workspaceSchema } from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";
import { Type } from "@sinclair/typebox";

const archiveWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

/** Archive one workspace; cleanup remains host-owned and asynchronous. */
export function archiveWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "archive_workspace",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: ["archive workspace", "remove worktree", "close branch workspace"],
        description:
            "Archive one workspace. The result includes complete project, base, owner, status, archivedAt, and timestamp detail; follow its detail cursor with get_workspace when the model-output budget requires another page. Archiving is the durable decision; the host may clean up its worktree and folder in the background.",
        parameters: archiveWorkspaceInputSchema,
        returnType: workspaceSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ workspaceId }) =>
            `archive workspace ${JSON.stringify(workspaceId)} and remove its host-managed worktree or folder`,
        execute: async (ctx, { workspaceId }, call) =>
            await workspaces.archive(ctx, workspaceId, { operationId: call.id }),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace archived:", workspace),
            },
        ],
    });
}

export { archiveWorkspaceInputSchema };
