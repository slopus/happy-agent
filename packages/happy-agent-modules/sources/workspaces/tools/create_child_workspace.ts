import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { workspaceBaseRefSchema, workspaceNameSchema, workspaceSchema } from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** The parent is relative to the caller; the model still names the work. */
export const createChildWorkspaceInputSchema = Type.Object(
    {
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);
export type CreateChildWorkspaceInput = Static<typeof createChildWorkspaceInputSchema>;

/** Create one workspace directly below the workspace the calling agent is working in. */
export function createChildWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "create_child_workspace",
        defer: true,
        capabilities: ["Create, inspect, rename, and archive Git workspaces and branches."],
        searchKeywords: ["child workspace", "nested worktree", "branch from current workspace"],
        description:
            'Create one persistent child workspace directly beneath the workspace you are currently working in. Give it a short title written the way a person would write it, such as "Retry policy rewrite": Happy Agent resolves the parent and builds the Git branch and folder from that title, so write a title rather than a slug or a path. You may supply baseRef to branch from a specific ref; otherwise the child inherits its parent workspace\'s branch. The workspace comes back while checkout and setup may still be running, and its parentId identifies its exact place in the workspace tree.',
        parameters: createChildWorkspaceInputSchema,
        returnType: workspaceSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CreateChildWorkspaceInput, call) =>
            await workspaces.createChildWorkspace(ctx, agentId, input.name, input.baseRef, call.id),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel(
                    "Child workspace created:",
                    workspace,
                ),
            },
        ],
    });
}
