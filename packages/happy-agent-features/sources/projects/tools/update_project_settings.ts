import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectSettingsUpdateResultSchema,
    type ProjectSettingsUpdateResult,
} from "../ProjectStore.js";
import {
    projectSettingsUpdateToolInputSchema,
    type ProjectSettingsUpdateToolInput,
} from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

export function updateProjectSettingsTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "update_project_settings",
        description:
            "Replace one project's bounded recursive JSON settings. Settings are validated for depth, per-level item/property/string limits, and encoded bytes before the host persists them.",
        parameters: projectSettingsUpdateToolInputSchema,
        returnType: projectSettingsUpdateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectSettingsUpdateToolInput) =>
            await projects.updateSettings(ctx, agentId, input),
        toLLM: (result: ProjectSettingsUpdateResult) => [
            {
                type: "text",
                text: projects.formatSettingsForModel(result.settings, result.projectId),
            },
        ],
    });
}