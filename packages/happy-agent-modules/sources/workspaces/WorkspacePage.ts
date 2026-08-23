import { Type, type Static } from "@sinclair/typebox";

import { workspaceProjectRefSchema, workspaceSchema } from "./Workspace.js";

export const MAX_WORKSPACE_PAGE_SIZE = 50;

/**
 * Every page in this module — the workspace list, one workspace's detail, and branch metadata
 * detail — is addressed the same way: an integer `cursor` in, `cursor` and `nextCursor` out. List
 * cursors count workspaces ordered by ascending ID; detail cursors count characters.
 */
export const workspaceCursorSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const workspacePageQuerySchema = Type.Object(
    {
        projectRef: Type.Optional(workspaceProjectRefSchema),
        includeArchived: Type.Optional(Type.Boolean()),
        cursor: Type.Optional(workspaceCursorSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export const workspacePageSchema = Type.Object(
    {
        workspaces: Type.Array(workspaceSchema, { maxItems: MAX_WORKSPACE_PAGE_SIZE }),
        cursor: workspaceCursorSchema,
        nextCursor: Type.Optional(workspaceCursorSchema),
    },
    { additionalProperties: false },
);

/** Kept as a public data helper for hosts that already hold a bounded list. */
export const workspaceListSchema = Type.Array(workspaceSchema, {
    maxItems: MAX_WORKSPACE_PAGE_SIZE,
});

export type WorkspacePageQuery = Static<typeof workspacePageQuerySchema>;
export type WorkspacePage = Static<typeof workspacePageSchema>;
export type WorkspaceList = Static<typeof workspaceListSchema>;
export type WorkspaceCursor = Static<typeof workspaceCursorSchema>;
