import { defineAgentTool } from "@slopus/happy-agent-base";

import { workspaceIdSchema, workspaceSchema } from "../Workspace.js";
import type { WorkspacesFeature } from "../WorkspacesFeature.js";
import { Type } from "@sinclair/typebox";

const archiveWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

/** Archive one workspace; cleanup remains host-owned and asynchronous. */
export function archiveWorkspaceTool(workspaces: WorkspacesFeature, agentId: string) {
    return defineAgentTool({
        name: "archive_workspace",
        description:
            "Archive one workspace. The result includes complete project, base, owner, status, archivedAt, and timestamp detail; follow its detail cursor with get_workspace when the model-output budget requires another page. Archiving is the durable decision; the host may clean up its worktree and folder in the background.",
        parameters: archiveWorkspaceInputSchema,
        returnType: workspaceSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { workspaceId }) =>
            await workspaces.archive(ctx, agentId, workspaceId),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace archived:", workspace),
            },
        ],
    });
}

export { archiveWorkspaceInputSchema };
