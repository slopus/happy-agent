import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { projectNameSchema, projectRemoteSourceSchema, projectSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

const cloneProjectInputSchema = Type.Object(
    {
        name: projectNameSchema,
        source: projectRemoteSourceSchema,
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
type CloneProjectInput = Static<typeof cloneProjectInputSchema>;

/** Start the existing durable remote-project provisioning workflow. */
export function cloneProjectTool(projects: ProjectsModule) {
    return defineAgentTool({
        name: "clone_project",
        defer: true,
        capabilities: ["Create projects from local folders and import Git or GitHub repositories."],
        searchKeywords: [
            "import project",
            "clone repository",
            "GitHub",
            "GitLab",
            "Bitbucket",
            "Git remote",
        ],
        description:
            'Import a remote Git repository as a Happy project in managed storage. Give a folder name and source: {kind: "github", repository: "owner/name"} for GitHub, or {kind: "git", url: "https://..."} for another Git host. Only HTTPS URLs without embedded credentials are supported; SSH URLs and local Git paths are not. For a private GitHub repository, use secret: {kind: "github"} to select the configured GitHub credential; never pass a token or password. This creates a local clone, not a repository on the hosting service. The project is returned before cloning finishes: follow list_projects until setup is ready or failed and report failures before starting work.',
        parameters: cloneProjectInputSchema,
        returnType: projectSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ name, source, secret }: CloneProjectInput) =>
            `cloning ${quoteVisibleExact(source.kind === "github" ? `https://github.com/${source.repository}` : source.url)} into managed project ${quoteVisibleExact(name)}. Access: external Git network access, host filesystem writes outside the current workspace, and installation-wide project catalog write${secret === undefined ? "" : "; uses the configured GitHub credential"}`,
        execute: async (ctx, input: CloneProjectInput, call) =>
            await projects.createRemote(ctx, {
                ...input,
                projectId: await call.kv.getOrCreate(ctx, "projectId", () => createId()),
            }),
        toLLM: (project) => [
            { type: "text", text: projects.formatProjectForModel("Project import:", project) },
        ],
    });
}
