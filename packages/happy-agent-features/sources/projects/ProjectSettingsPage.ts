import { Type, type Static } from "@sinclair/typebox";

import {
    MAX_PROJECT_DETAIL_PAGE_SIZE,
    MAX_PROJECT_DETAIL_CHARACTERS,
} from "./ProjectDetailPage.js";
import { projectIdSchema, projectSettingsSchema } from "./Project.js";

export const MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE = MAX_PROJECT_DETAIL_PAGE_SIZE;
export const MAX_PROJECT_SETTINGS_DETAIL_CHARACTERS = MAX_PROJECT_DETAIL_CHARACTERS;

export const projectSettingsDetailCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_SETTINGS_DETAIL_CHARACTERS,
});

export const projectSettingsDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(projectSettingsDetailCursorSchema),
        detailLimit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE,
            }),
        ),
    },
    { additionalProperties: false },
);

export const projectSettingsPageSchema = Type.Object(
    {
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
        detail: Type.String({ maxLength: MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE }),
        detailOffset: projectSettingsDetailCursorSchema,
        detailTotal: projectSettingsDetailCursorSchema,
        nextDetailOffset: Type.Optional(projectSettingsDetailCursorSchema),
    },
    { additionalProperties: false },
);

export type ProjectSettingsDetailCursor = Static<typeof projectSettingsDetailCursorSchema>;
export type ProjectSettingsDetailQuery = Static<typeof projectSettingsDetailQuerySchema>;
export type ProjectSettingsPage = Static<typeof projectSettingsPageSchema>;