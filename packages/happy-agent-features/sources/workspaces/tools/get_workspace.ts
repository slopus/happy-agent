import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceDetailPageSchema,
    workspaceDetailQuerySchema,
    type WorkspaceDetailQuery,
} from "../WorkspaceDetailPage.js";
import { workspaceIdSchema } from "../Workspace.js";
import type { WorkspacesFeature } from "../WorkspacesFeature.js";

const getWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, ...workspaceDetailQuerySchema.properties },
    { additionalProperties: false },
);
const getWorkspaceResultSchema = workspaceDetailPageSchema;

/** Read one complete workspace by opaque ID and page its actionable detail. */
export function getWorkspaceTool(workspaces: WorkspacesFeature, agentId: string) {
    return defineAgentTool({
        name: "get_workspace",
        description:
            "Read one persistent workspace by ID, including complete status, project, base, ownership, and timestamp detail. Follow the returned detail cursor when the workspace is too large for one response.",
        parameters: getWorkspaceInputSchema,
        returnType: getWorkspaceResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { workspaceId, ...query }: { workspaceId: string } & WorkspaceDetailQuery,
        ) => await workspaces.getPage(ctx, agentId, workspaceId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: workspaces.formatDetailPageForModel(page),
            },
        ],
    });
}

export { getWorkspaceInputSchema, getWorkspaceResultSchema };
