import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectPageQuerySchema,
    projectPageSchema,
    type ProjectPageQuery,
} from "../ProjectPage.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

export function listProjectsTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "list_projects",
        description:
            "List a bounded page of registered projects. Each row includes an actionable project ID, name, opaque repository reference, status, and useful context. Use nextCursor to continue.",
        parameters: projectPageQuerySchema,
        returnType: projectPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: ProjectPageQuery) =>
            await projects.listPage(ctx, agentId, query),
        toLLM: (page) => [{ type: "text", text: projects.formatPageForModel(page) }],
    });
}