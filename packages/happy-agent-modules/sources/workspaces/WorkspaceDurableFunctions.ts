import { Type, type Static } from "@sinclair/typebox";

import {
    durableEntityArgumentsSchema,
    durableProvisionResultSchema,
} from "../durableFunctions/index.js";
import { workspaceAgentIdSchema, workspaceErrorSchema, workspaceIdSchema } from "./Workspace.js";

export const WORKSPACE_PROVISION_FUNCTION = "workspaces.provision";
export const WORKSPACE_ARCHIVE_FUNCTION = "workspaces.archive";

export const workspaceDurableArgumentsSchema = durableEntityArgumentsSchema(workspaceIdSchema);

/** Provisioning also carries the agent to tell if the checkout fails after creation returned. */
export const workspaceProvisionArgumentsSchema = Type.Object(
    { id: workspaceIdSchema, reportFailureTo: Type.Optional(workspaceAgentIdSchema) },
    { additionalProperties: false },
);

export const workspaceProvisionResultSchema = durableProvisionResultSchema(workspaceErrorSchema);
export const workspaceArchiveResultSchema = Type.Null();

export type WorkspaceProvisionResult = Static<typeof workspaceProvisionResultSchema>;

export const workspaceOperationId = (operation: "create" | "archive", id: string) =>
    `workspace-${operation}.${id}`;

export function workspaceLockKey(workspaceId: string): string {
    return `workspace.${workspaceId}`;
}
