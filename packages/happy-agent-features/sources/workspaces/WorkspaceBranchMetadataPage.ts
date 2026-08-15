import { Type, type Static } from "@sinclair/typebox";

import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";

/**
 * Branch names, heads, and upstreams are each bounded but may still exceed a
 * small model-output budget together. Keep the host result at the top level
 * and page the human-readable detail stream separately.
 */
export const MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE = 1_024;
export const MAX_WORKSPACE_BRANCH_METADATA_DETAIL_CHARACTERS = 2_048;

export const workspaceBranchMetadataDetailCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_BRANCH_METADATA_DETAIL_CHARACTERS,
});

export const workspaceBranchMetadataDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(workspaceBranchMetadataDetailCursorSchema),
        detailLimit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE,
            }),
        ),
    },
    { additionalProperties: false },
);

export const workspaceBranchMetadataPageSchema = Type.Object(
    {
        ...workspaceBranchMetadataSchema.properties,
        detail: Type.String({ maxLength: MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE }),
        detailOffset: workspaceBranchMetadataDetailCursorSchema,
        detailTotal: workspaceBranchMetadataDetailCursorSchema,
        nextDetailOffset: Type.Optional(workspaceBranchMetadataDetailCursorSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceBranchMetadataDetailCursor = Static<
    typeof workspaceBranchMetadataDetailCursorSchema
>;
export type WorkspaceBranchMetadataDetailQuery = Static<
    typeof workspaceBranchMetadataDetailQuerySchema
>;
export type WorkspaceBranchMetadataPage = Static<typeof workspaceBranchMetadataPageSchema>;

export type WorkspaceBranchMetadataDetail = WorkspaceBranchMetadata & {
    detail: string;
    detailOffset: number;
    detailTotal: number;
    nextDetailOffset?: number;
};
