import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceCreateToolInputSchema,
    workspaceSchema,
    type WorkspaceCreateToolInput,
} from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** Create one host-managed workspace: a folder, and the branch that names the work in it. */
export function createWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "create_workspace",
        description:
            'Create one persistent workspace for isolated work. Give it a short title written the way a person would write it, such as "Retry policy rewrite": Happy Agent builds the Git branch and the folder from that title, so write a title rather than a slug or a path. The workspace comes back while its checkout and setup may still be running; the result includes complete branch, path, base, status, and ownership detail, and you can follow its detail cursor with get_workspace when the model-output budget requires another page.',
        parameters: workspaceCreateToolInputSchema,
        returnType: workspaceSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkspaceCreateToolInput, call) => {
            const { projectRef, ...request } = input;
            const workspace = await workspaces.createWorkspace(
                ctx,
                projectRef,
                { ...request, nameConfigured: true },
                agentId,
                {
                    operationId: call.id,
                },
            );
            if (workspace === undefined) {
                throw new Error(`Project "${projectRef}" was not found.`);
            }
            return workspace;
        },
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace created:", workspace),
            },
        ],
    });
}
