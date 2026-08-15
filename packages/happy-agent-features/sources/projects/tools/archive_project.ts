import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectIdSchema, projectSchema } from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";
import { Type } from "@sinclair/typebox";

const archiveProjectInputSchema = Type.Object(
    { projectId: projectIdSchema },
    { additionalProperties: false },
);

export function archiveProjectTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "archive_project",
        description:
            "Logically archive one project. Archival is the durable decision; any host folder or Git cleanup is an independent asynchronous concern and cannot undo the archived state.",
        parameters: archiveProjectInputSchema,
        returnType: projectSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { projectId }) =>
            await projects.archive(ctx, agentId, projectId),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectOperationForModel("Project archived:", project),
            },
        ],
    });
}

export { archiveProjectInputSchema };