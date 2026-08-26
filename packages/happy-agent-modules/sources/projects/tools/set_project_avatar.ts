import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { MAX_PROJECT_AVATAR_BYTES, projectIdSchema, type Project } from "../Project.js";
import { ProjectAvatarInputError } from "../ProjectAvatarInputError.js";
import type { ProjectsModule } from "../ProjectsModule.js";

const setProjectAvatarInputSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);
type SetProjectAvatarInput = Static<typeof setProjectAvatarInputSchema>;

/** Let a model choose a project's picture from an image file in that project. */
export function setProjectAvatarTool(projects: ProjectsModule) {
    return defineAgentTool({
        name: "set_project_avatar",
        defer: true,
        capabilities: ["Choose a configured project's avatar picture."],
        searchKeywords: ["project avatar", "project picture", "repository image"],
        description:
            "Set a project's avatar from an image file in that project's folder. Give the project ID from list_projects and the path to a PNG, JPEG, or WebP image, up to 8 MiB; write or generate the image first, then point this tool at it. The picture is resized to a square-fitting WebP and shown wherever the project appears.",
        parameters: setProjectAvatarInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SetProjectAvatarInput) => {
            const project = await projects.get(ctx, input.projectId);
            if (project === undefined) throw new Error("The project was not found.");
            const bytes = await readImageWithin(project, input.path);
            await projects.setAvatar(ctx, {
                bytes,
                projectId: project.id,
                source: "generated",
            });
        },
        toLLM: () => [
            {
                type: "text",
                text: "The project avatar is set.",
            },
        ],
    });
}

/** Reads the image while refusing paths and symlinks that leave the selected project. */
async function readImageWithin(project: Project, requested: string): Promise<Uint8Array> {
    const candidate = isAbsolute(requested) ? requested : resolve(project.repositoryRef, requested);
    const folder = await realpath(project.repositoryRef).catch(() => undefined);
    if (folder === undefined) {
        throw new ProjectAvatarInputError("The project's folder is not available.");
    }
    const target = await realpath(candidate).catch(() => undefined);
    if (target === undefined) {
        throw new ProjectAvatarInputError(`There is no image at ${requested}.`);
    }
    if (target !== folder && !target.startsWith(folder + sep)) {
        throw new ProjectAvatarInputError(
            "The avatar image must live inside the project's folder.",
        );
    }
    const facts = await stat(target);
    if (!facts.isFile()) {
        throw new ProjectAvatarInputError("The avatar path must name an image file.");
    }
    if (facts.size === 0 || facts.size > MAX_PROJECT_AVATAR_BYTES) {
        throw new ProjectAvatarInputError("The avatar image must be no larger than 8 MiB.");
    }
    return new Uint8Array(await readFile(target));
}
