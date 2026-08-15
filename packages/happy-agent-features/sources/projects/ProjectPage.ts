import { Type, type Static } from "@sinclair/typebox";

import { projectStatusSchema, projectSchema } from "./Project.js";

export const MAX_PROJECT_PAGE_SIZE = 100;
export const MAX_PROJECT_CURSOR_LENGTH = 16;

export const projectCursorSchema = Type.String({
    pattern: "^(0|[1-9][0-9]*)$",
    maxLength: MAX_PROJECT_CURSOR_LENGTH,
});

export const projectPageQuerySchema = Type.Object(
    {
        status: Type.Optional(projectStatusSchema),
        includeArchived: Type.Optional(Type.Boolean()),
        cursor: Type.Optional(projectCursorSchema),
        limit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_PROJECT_PAGE_SIZE,
            }),
        ),
    },
    { additionalProperties: false },
);

export const projectPageSchema = Type.Object(
    {
        projects: Type.Array(projectSchema, { maxItems: MAX_PROJECT_PAGE_SIZE }),
        nextCursor: Type.Optional(projectCursorSchema),
    },
    { additionalProperties: false },
);

export const projectListSchema = Type.Array(projectSchema, {
    maxItems: MAX_PROJECT_PAGE_SIZE,
});

export type ProjectPageQuery = Static<typeof projectPageQuerySchema>;
export type ProjectPage = Static<typeof projectPageSchema>;
export type ProjectList = Static<typeof projectListSchema>;
export type ProjectCursor = Static<typeof projectCursorSchema>;