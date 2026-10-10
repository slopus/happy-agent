import { Type } from "@sinclair/typebox";
import { computeSchema } from "@slopus/happy-agent-client";
import {
    projectIdSchema,
    projectRepositoryRefSchema,
    projectSchema,
} from "../../../../happy-agent-modules/sources/projects/Project.ts";
import {
    projectPageQuerySchema,
    projectPageSchema,
} from "../../../../happy-agent-modules/sources/projects/ProjectPage.ts";
import { projectAgentOrderSchema } from "../../../../happy-agent-modules/sources/projects/ProjectAgentAssociation.ts";
import {
    workspaceIdSchema,
    workspaceSchema,
} from "../../../../happy-agent-modules/sources/workspaces/Workspace.ts";
import {
    workspacePageQuerySchema,
    workspacePageSchema,
} from "../../../../happy-agent-modules/sources/workspaces/WorkspacePage.ts";
import { workspaceAgentOrderSchema } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceAgent.ts";

export const ownerCatalogSchemas = {
    ownerProjectId: projectIdSchema,
    ownerProjectRepositoryRef: projectRepositoryRefSchema,
    ownerProjectRunnerId: projectSchema.properties.runnerId,
    ownerProjectPageQuery: projectPageQuerySchema,
    ownerProjectPage: projectPageSchema,
    ownerProjectAgentOrders: Type.Array(projectAgentOrderSchema),
    ownerWorkspaceId: workspaceIdSchema,
    ownerWorkspacePageQuery: workspacePageQuerySchema,
    ownerWorkspacePage: workspacePageSchema,
    ownerWorkspaceAgentOrders: Type.Array(workspaceAgentOrderSchema),
    ownerCatalogCompute: computeSchema,
};

// Retained here so the golden exporter and native queries share the shipped row vocabulary.
export const ownerCatalogRowSchemas = { project: projectSchema, workspace: workspaceSchema };
