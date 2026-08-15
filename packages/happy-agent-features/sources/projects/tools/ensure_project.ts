import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectEnsureResultSchema,
    type ProjectEnsureResult,
} from "../ProjectStore.js";
import {
    projectEnsureToolInputSchema,
    type ProjectEnsureToolInput,
} from "../Project.js";
import type { ProjectsFeature } from "../ProjectsFeature.js";

export function ensureProjectTool(projects: ProjectsFeature, agentId: string) {
    return defineAgentTool({
        name: "ensure_project",
        description:
            "Ensure a detected repository is registered exactly once. If this opaque repository reference already has a project, the existing project is returned with created=false; otherwise one project is created with created=true. The host store performs the repository uniqueness decision transactionally.",
        parameters: projectEnsureToolInputSchema,
        returnType: projectEnsureResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectEnsureToolInput) =>
            await projects.ensure(ctx, agentId, input),
        toLLM: (result: ProjectEnsureResult) => [
            {
                type: "text",
                text: projects.formatProjectOperationForModel(
                    result.created ? "Project ensured and created:" : "Project already registered:",
                    result.project,
                ),
            },
        ],
    });
}