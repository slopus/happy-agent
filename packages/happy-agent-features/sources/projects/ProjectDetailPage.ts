import { Type, type Static } from "@sinclair/typebox";

import { projectSchema } from "./Project.js";

export const MAX_PROJECT_DETAIL_PAGE_SIZE = 1_024;
export const MAX_PROJECT_DETAIL_CHARACTERS = 16 * 1024;

export const projectDetailCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_DETAIL_CHARACTERS,
});

export const projectDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(projectDetailCursorSchema),
        detailLimit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_PROJECT_DETAIL_PAGE_SIZE,
            }),
        ),
    },
    { additionalProperties: false },
);

const projectDetailResultSchema = Type.Object(
    {
        project: projectSchema,
        detail: Type.String({ maxLength: MAX_PROJECT_DETAIL_PAGE_SIZE }),
        detailOffset: projectDetailCursorSchema,
        detailTotal: projectDetailCursorSchema,
        nextDetailOffset: Type.Optional(projectDetailCursorSchema),
    },
    { additionalProperties: false },
);

export const projectDetailPageSchema = Type.Union([
    projectDetailResultSchema,
    Type.Object({ project: Type.Null() }, { additionalProperties: false }),
]);

export type ProjectDetailCursor = Static<typeof projectDetailCursorSchema>;
export type ProjectDetailQuery = Static<typeof projectDetailQuerySchema>;
export type ProjectDetailPage = Static<typeof projectDetailPageSchema>;
export type ProjectDetailResult = Extract<
    ProjectDetailPage,
    { readonly project: Static<typeof projectSchema> }
>;