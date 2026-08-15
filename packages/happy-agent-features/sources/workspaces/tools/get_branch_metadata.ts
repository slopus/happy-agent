import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceBranchMetadataDetailQuerySchema,
    workspaceBranchMetadataPageSchema,
    type WorkspaceBranchMetadataDetailQuery,
} from "../WorkspaceBranchMetadataPage.js";
import { workspaceIdSchema } from "../Workspace.js";
import type { WorkspacesFeature } from "../WorkspacesFeature.js";

const branchMetadataInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, ...workspaceBranchMetadataDetailQuerySchema.properties },
    { additionalProperties: false },
);

/** Read bounded host-produced branch metadata for a workspace. */
export function getBranchMetadataTool(workspaces: WorkspacesFeature, agentId: string) {
    return defineAgentTool({
        name: "get_workspace_branch_metadata",
        description:
            "Read the current branch metadata reported by the host for one workspace. Follow the returned detail cursor to read complete branch, head, upstream, and ahead/behind values. Git, worktrees, and paths remain outside the feature.",
        parameters: branchMetadataInputSchema,
        returnType: workspaceBranchMetadataPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { workspaceId, ...query }: { workspaceId: string } & WorkspaceBranchMetadataDetailQuery,
        ) => await workspaces.branchMetadataPage(ctx, agentId, workspaceId, query),
        toLLM: (metadata) => [
            {
                type: "text",
                text: workspaces.formatBranchMetadataDetailPageForModel(metadata),
            },
        ],
    });
}

export { branchMetadataInputSchema };
