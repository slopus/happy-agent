import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceDetailPageSchema,
    workspaceDetailQuerySchema,
    type WorkspaceDetailQuery,
} from "../WorkspaceDetailPage.js";
import { workspaceIdSchema } from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

const getWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, ...workspaceDetailQuerySchema.properties },
    { additionalProperties: false },
);
const getWorkspaceResultSchema = workspaceDetailPageSchema;

/** Read one complete workspace by ID and page its actionable detail. */
export function getWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "get_workspace",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: [
            "workspace details",
            "worktree folder",
            "branch status",
            "workspace setup",
        ],
        description:
            "Read one persistent workspace by ID, including its branch, folder, base, Git state, status, ownership, and timestamps. Follow the returned cursor when the workspace is too large for one response.",
        parameters: getWorkspaceInputSchema,
        returnType: getWorkspaceResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { workspaceId, ...query }: { workspaceId: string } & WorkspaceDetailQuery,
        ) => await workspaces.getPage(ctx, workspaceId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: workspaces.formatDetailPageForModel(page),
            },
        ],
    });
}

export { getWorkspaceInputSchema, getWorkspaceResultSchema };
