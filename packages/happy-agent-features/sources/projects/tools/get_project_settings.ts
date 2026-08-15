import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectSettingsDetailQuerySchema,
    projectSettingsPageSchema,
    type ProjectSettingsDetailQuery,
} from "../ProjectSettingsPage.js";
import { projectIdSchema } from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

const getProjectSettingsInputSchema = Type.Object(
    { projectId: projectIdSchema, ...projectSettingsDetailQuerySchema.properties },
    { additionalProperties: false },
);

export function getProjectSettingsTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "get_project_settings",
        description:
            "Read bounded JSON settings for one project. The result includes the project ID, settings, and a detail cursor; follow nextDetailOffset until the complete settings stream has been read.",
        parameters: getProjectSettingsInputSchema,
        returnType: projectSettingsPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { projectId, ...query }: { projectId: string } & ProjectSettingsDetailQuery,
        ) => await projects.readSettingsPage(ctx, agentId, projectId, query),
        toLLM: (page) => [{ type: "text", text: projects.formatSettingsPageForModel(page) }],
    });
}

export { getProjectSettingsInputSchema };