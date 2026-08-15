import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectDetailPageSchema,
    projectDetailQuerySchema,
    type ProjectDetailQuery,
} from "../ProjectDetailPage.js";
import { projectIdSchema } from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

const getProjectInputSchema = Type.Object(
    { projectId: projectIdSchema, ...projectDetailQuerySchema.properties },
    { additionalProperties: false },
);

export function getProjectTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "get_project",
        description:
            "Read one project by ID with complete name, opaque repository reference, status, ownership, description, and timestamps. Follow the returned detail cursor when the model-output budget requires another page.",
        parameters: getProjectInputSchema,
        returnType: projectDetailPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { projectId, ...query }: { projectId: string } & ProjectDetailQuery,
        ) => await projects.getPage(ctx, agentId, projectId, query),
        toLLM: (page) => [{ type: "text", text: projects.formatDetailPageForModel(page) }],
    });
}

export { getProjectInputSchema };