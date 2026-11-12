import { Type, type Static } from "@sinclair/typebox";

import {
    workspaceBaseRefSchema,
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceNameSchema,
    workspaceOperationIdSchema,
    workspaceParentIdSchema,
} from "./Workspace.js";

/** What a caller asks for when it wants one new workspace in a project. */
export const createWorkspaceRequestSchema = Type.Object(
    {
        baseRef: Type.Optional(workspaceBaseRefSchema),
        id: Type.Optional(workspaceIdSchema),
        name: workspaceNameSchema,
        nameConfigured: Type.Optional(Type.Boolean()),
        /** The project ID is the implicit root; another value names a ready workspace parent. */
        parentId: Type.Optional(workspaceParentIdSchema),
    },
    { additionalProperties: false },
);
export type CreateWorkspaceRequest = Static<typeof createWorkspaceRequestSchema>;

/** The durable operation and resident subtask that own workspace creation. */
export const workspaceCreatorOptionsSchema = Type.Object(
    {
        /** Durable internal identity for a retried caller operation, such as an agent tool call. */
        operationId: Type.Optional(workspaceOperationIdSchema),
        /** Resident subtask, set only by the subtask creation operation. */
        subtaskAgentId: Type.Optional(workspaceAgentIdSchema),
        /** The agent told when the background checkout fails after creation has returned. */
        reportFailureTo: Type.Optional(workspaceAgentIdSchema),
    },
    { additionalProperties: false },
);
export type WorkspaceCreatorOptions = Static<typeof workspaceCreatorOptionsSchema>;
