import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { projectRepositoryRefSchema, projectSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

const createProjectInputSchema = Type.Object(
    { path: projectRepositoryRefSchema },
    { additionalProperties: false },
);
type CreateProjectInput = Static<typeof createProjectInputSchema>;

/** Register a local folder using the same catalog and setup path as the public API. */
export function createProjectTool(projects: ProjectsModule) {
    return defineAgentTool({
        name: "create_project",
        defer: true,
        capabilities: ["Create projects from local folders and import Git or GitHub repositories."],
        searchKeywords: [
            "new project",
            "register project",
            "import local repository",
            "add folder",
        ],
        description:
            "Create a Happy project from an existing local folder, whether or not it uses Git. Supply its absolute path. For a brand-new project, first create the folder with the shell under the user's permission policy, then register it here. Existing projects are reused; archived projects are restored. Setup runs in the background: use list_projects to check readiness before starting work. Use clone_project to import a remote repository.",
        parameters: createProjectInputSchema,
        returnType: projectSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ path }: CreateProjectInput) =>
            `registering the local folder ${quoteVisibleExact(path)} as a Happy project. Access: host filesystem inspection, installation-wide project catalog write, and background repository setup outside the current workspace`,
        execute: async (ctx, input: CreateProjectInput, call) =>
            await projects.register(ctx, {
                ...input,
                projectId: await call.kv.getOrCreate(ctx, "projectId", () => createId()),
            }),
        toLLM: (project) => [
            { type: "text", text: projects.formatProjectForModel("Project registered:", project) },
        ],
    });
}
