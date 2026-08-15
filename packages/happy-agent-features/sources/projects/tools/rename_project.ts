import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectSchema,
    type ProjectRenameToolInput,
    projectRenameToolInputSchema,
} from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

export function renameProjectTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "rename_project",
        description:
            "Change a project's display name. Supply the actionable project ID from list_projects or get_project; the opaque repository reference and other identity fields remain unchanged.",
        parameters: projectRenameToolInputSchema,
        returnType: projectSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectRenameToolInput) =>
            await projects.rename(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectOperationForModel("Project renamed:", project),
            },
        ],
    });
}