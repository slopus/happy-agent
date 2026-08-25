import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceBranchMetadataDetailQuerySchema,
    workspaceBranchMetadataPageSchema,
    type WorkspaceBranchMetadataDetailQuery,
} from "../WorkspaceBranchMetadataPage.js";
import { workspaceIdSchema } from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

const branchMetadataInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, ...workspaceBranchMetadataDetailQuerySchema.properties },
    { additionalProperties: false },
);

/** Read bounded host-produced branch metadata for a workspace. */
export function getBranchMetadataTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "get_workspace_branch_metadata",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: [
            "Git branch metadata",
            "ahead behind",
            "workspace HEAD",
            "upstream branch",
        ],
        description:
            "Read the current branch metadata reported by the host for one workspace. Follow the returned cursor to read complete branch, head, upstream, and ahead/behind values. Git, worktrees, and paths remain outside the module.",
        parameters: branchMetadataInputSchema,
        returnType: workspaceBranchMetadataPageSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { workspaceId, ...query }: { workspaceId: string } & WorkspaceBranchMetadataDetailQuery,
        ) => await workspaces.branchMetadataPage(ctx, workspaceId, query),
        toLLM: (metadata) => [
            {
                type: "text",
                text: workspaces.formatBranchMetadataDetailPageForModel(metadata),
            },
        ],
    });
}

export { branchMetadataInputSchema };
