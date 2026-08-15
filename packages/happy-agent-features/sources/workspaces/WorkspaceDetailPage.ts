import { Type, type Static } from "@sinclair/typebox";

import { workspaceSchema } from "./Workspace.js";

/**
 * A workspace row contains several independently bounded fields. Detail is
 * exposed as a stable character stream so a small model-output budget cannot
 * silently hide project, ownership, or timestamp information.
 */
export const MAX_WORKSPACE_DETAIL_PAGE_SIZE = 1_024;
export const MAX_WORKSPACE_DETAIL_CHARACTERS = 8_192;

export const workspaceDetailCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_DETAIL_CHARACTERS,
});

export const workspaceDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(workspaceDetailCursorSchema),
        detailLimit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKSPACE_DETAIL_PAGE_SIZE }),
        ),
    },
    { additionalProperties: false },
);

const workspaceDetailResultSchema = Type.Object(
    {
        workspace: workspaceSchema,
        detail: Type.String({ maxLength: MAX_WORKSPACE_DETAIL_PAGE_SIZE }),
        detailOffset: workspaceDetailCursorSchema,
        detailTotal: workspaceDetailCursorSchema,
        nextDetailOffset: Type.Optional(workspaceDetailCursorSchema),
    },
    { additionalProperties: false },
);

/** A bounded workspace lookup result, or a stable empty result for an unknown ID. */
export const workspaceDetailPageSchema = Type.Union([
    workspaceDetailResultSchema,
    Type.Object({ workspace: Type.Null() }, { additionalProperties: false }),
]);

export type WorkspaceDetailCursor = Static<typeof workspaceDetailCursorSchema>;
export type WorkspaceDetailQuery = Static<typeof workspaceDetailQuerySchema>;
export type WorkspaceDetailPage = Static<typeof workspaceDetailPageSchema>;

export type WorkspaceDetailResult = Extract<
    WorkspaceDetailPage,
    { readonly workspace: Static<typeof workspaceSchema> }
>;
