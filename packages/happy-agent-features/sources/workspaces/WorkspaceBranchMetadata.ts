import { Type, type Static } from "@sinclair/typebox";

import { workspaceIdSchema } from "./Workspace.js";

/**
 * Git facts are host-produced metadata. The feature forwards no path or Git
 * command and only accepts this bounded portable representation.
 */
export const workspaceBranchMetadataSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        head: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        upstream: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        ahead: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
        behind: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
        detached: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type WorkspaceBranchMetadata = Static<typeof workspaceBranchMetadataSchema>;
