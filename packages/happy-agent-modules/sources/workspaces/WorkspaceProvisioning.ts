import { Type, type Static } from "@sinclair/typebox";

import { projectCreatorSchema } from "../git/index.js";

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
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
export type CreateWorkspaceRequest = Static<typeof createWorkspaceRequestSchema>;

/** Who asked for the workspace, its durable operation identity, and any credential it needs. */
export const workspaceCreatorOptionsSchema = Type.Object(
    {
        createdBy: Type.Optional(projectCreatorSchema),
        githubToken: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
        /** Durable internal identity for a retried caller operation, such as an agent tool call. */
        operationId: Type.Optional(workspaceOperationIdSchema),
        /** Resident subtask, set only by the subtask creation operation. */
        subtaskAgentId: Type.Optional(workspaceAgentIdSchema),
    },
    { additionalProperties: false },
);
export type WorkspaceCreatorOptions = Static<typeof workspaceCreatorOptionsSchema>;
