import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectPageQuerySchema,
    projectPageSchema,
    type ProjectPageQuery,
} from "../ProjectPage.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function listProjectsTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "list_projects",
        defer: true,
        capabilities: ["List configured Happy Agent projects."],
        searchKeywords: ["project catalog", "repositories", "project folders"],
        description:
            "List a bounded page of projects in catalog order. Each row carries the project ID to act on, its name, its folder, and whether it is still being set up. Use nextCursor to continue.",
        parameters: projectPageQuerySchema,
        returnType: projectPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: ProjectPageQuery) => await projects.list(ctx, query),
        toLLM: (page) => [{ type: "text", text: projects.formatPageForModel(page) }],
    });
}
