import { Type, type Static } from "@sinclair/typebox";

import { workspaceProjectRefSchema, workspaceSchema } from "./Workspace.js";

export const MAX_WORKSPACE_PAGE_SIZE = 100;
export const MAX_WORKSPACE_CURSOR_LENGTH = 16;

/**
 * Cursors are decimal integer offsets over workspaces ordered strictly by
 * ascending workspace ID. A host must return unique identities and exactly
 * `cursor + returned.length` when it exposes a continuation.
 */
export const workspaceCursorSchema = Type.String({
    pattern: "^(0|[1-9][0-9]*)$",
    maxLength: MAX_WORKSPACE_CURSOR_LENGTH,
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
