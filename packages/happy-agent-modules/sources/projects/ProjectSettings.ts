import { Type, type Static } from "@sinclair/typebox";

import { projectIdSchema, projectVersionSchema } from "./Project.js";

export const MAX_PROJECT_DOCKER_IMAGE_LENGTH = 512;
export const MAX_PROJECT_WORKSPACE_INITIAL_PROMPT_LENGTH = 32_000;

/**
 * What the first agent in every new workspace of this project is told, verbatim. It is prose a
 * person wrote for a model, so line breaks are ordinary; NUL is the one character refused. The
 * setting is absent rather than empty when there is nothing to say.
 */
export const projectWorkspaceInitialPromptSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_WORKSPACE_INITIAL_PROMPT_LENGTH,
    pattern: "^[^\\u0000]+$",
});

/**
 * Where new workspaces of this project run. Settings are a small, closed
 * object rather than free-form JSON: every field has a defined meaning and a
 * reader on the host side.
 */
export const projectWorkspaceComputeSchema = Type.Union([
    Type.Object({ type: Type.Literal("local") }, { additionalProperties: false }),
    Type.Object(
        {
            image: Type.String({
                minLength: 1,
                maxLength: MAX_PROJECT_DOCKER_IMAGE_LENGTH,
                pattern: "^\\S+$",
            }),
            type: Type.Literal("docker"),
        },
        { additionalProperties: false },
    ),
]);

export const projectSettingsSchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Optional(projectWorkspaceComputeSchema),
        workspaceInitialPrompt: Type.Optional(projectWorkspaceInitialPromptSchema),
    },
    { additionalProperties: false },
);

/** What a settings read hands back: the project it belongs to, and the settings. */
export const projectSettingsViewSchema = Type.Object(
    {
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export type ProjectWorkspaceCompute = Static<typeof projectWorkspaceComputeSchema>;
export type ProjectWorkspaceInitialPrompt = Static<typeof projectWorkspaceInitialPromptSchema>;
export type ProjectSettings = Static<typeof projectSettingsSchema>;
export type ProjectSettingsView = Static<typeof projectSettingsViewSchema>;
export type ProjectSettingsUpdateInput = Static<typeof projectSettingsUpdateInputSchema>;
