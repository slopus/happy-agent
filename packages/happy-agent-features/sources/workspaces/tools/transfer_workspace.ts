import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceSessionTransferToolInputSchema,
    workspaceTransferResultSchema,
    type WorkspaceSessionTransferInput,
} from "../WorkspaceTransfer.js";
import type { WorkspacesFeature } from "../WorkspacesFeature.js";

/** Ask the host to schedule a durable session transfer into another workspace. */
export function transferWorkspaceTool(workspaces: WorkspacesFeature, agentId: string) {
    return defineAgentTool({
        name: "transfer_workspace",
        description:
            "Transfer this agent or session into an existing workspace. The host owns snapshot, checkout, and filesystem behavior; use the returned state to follow the transfer.",
        parameters: workspaceSessionTransferToolInputSchema,
        returnType: workspaceTransferResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkspaceSessionTransferInput) =>
            await workspaces.transfer(ctx, agentId, input),
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.state === "scheduled"
                        ? `Workspace transfer scheduled for ${result.targetWorkspaceId ?? "the requested workspace"}.`
                        : `Workspace transfer completed for ${
                              result.targetWorkspaceId ?? result.workspace.id
                          }.`,
            },
        ],
    });
}
