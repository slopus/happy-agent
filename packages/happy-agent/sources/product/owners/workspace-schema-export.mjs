import { Type } from "@sinclair/typebox";
import {
    workspaceIdSchema,
    workspaceBranchSchema,
    workspaceInheritNameInputSchema,
} from "../../../../happy-agent-modules/sources/workspaces/Workspace.ts";
import { createWorkspaceRequestSchema } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceProvisioning.ts";
export const workspaceNamingSchemas = {
    ownerWorkspaceDomainCreate: createWorkspaceRequestSchema,
    ownerWorkspaceInheritName: workspaceInheritNameInputSchema,
    // Native private durable intent for the original post-commit Git rename.
    ownerWorkspaceRenameIntent: Type.Object(
        { workspaceId: workspaceIdSchema, from: workspaceBranchSchema, to: workspaceBranchSchema },
        { additionalProperties: false },
    ),
};
