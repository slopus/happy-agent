import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { Compute, ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { StoriesModule } from "../StoriesModule.js";

const postStoryInputSchema = Type.Object(
    {
        path: Type.String({
            minLength: 1,
            maxLength: 4096,
            description:
                "An image, or an H.264 .mp4 video, on your machine, absolute or relative to your working directory",
        }),
        caption: Type.Optional(
            Type.String({ minLength: 1, maxLength: 200, description: "A few plain words" }),
        ),
    },
    { additionalProperties: false },
);

/** Post one image or video story on this task's or bot's row for a day. */
export function postStoryTool(
    stories: StoriesModule,
    computeModule: ComputeModule,
    compute: Compute,
    chatMedia: ChatMediaModule,
    scope: AgentModuleScope,
) {
    return defineAgentTool({
        name: "post_story",
        defer: false,
        capabilities: ["Post an image or video story on this conversation's row for a day."],
        description:
            "Post a story: an image or a short H.264 .mp4 video with a few plain words, shown on this conversation's icon for 24 hours to everyone who can see it. Post when something ships or is ready to look at, such as a screenshot or a short screen recording of it working. Each call adds one story; several play in order. Don't post progress chatter.",
        parameters: postStoryInputSchema,
        returnType: Type.Object({ id: Type.String(), expiresAt: Type.Integer() }),
        // The call's ID is the story's, so a replay posts nothing new.
        durable: true,
        shouldReviewInAutoMode: ({ path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, path, { write: false }),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, path, { write: false }),
        describeAutoPermissionAction: ({ path }) =>
            `posting ${quoteVisibleExact(path)} from this machine as a story everyone who can see this conversation sees for a day. Access: local file read (outside-workspace or symlink targets require full access)`,
        execute: async (ctx, { path, caption }, call) => {
            if (!(await stories.canPost(ctx, scope))) {
                throw new Error(
                    "Stories are off for the person you work for, so nothing was posted.",
                );
            }
            const permissions = computeModule.permissionsForContext(ctx);
            const resolved = computeModule.resolvePath(compute, path);
            const name = resolved.split(/[\\/]/u).at(-1) ?? path;
            const limit = chatMedia.limit(name);
            if (limit.kind !== "image" && limit.mimeType !== "video/mp4") {
                throw new Error("A story is an image or an H.264 .mp4 video.");
            }
            const { maxBytes } = limit;
            const bytes = await compute.fs.readFileBuffer(permissions, resolved, { maxBytes });
            const item = await chatMedia.snapshot(bytes, name);
            const { kind, mimeType, size, sha256 } = item;
            if (size === 0 || (kind !== "image" && kind !== "video")) {
                throw new Error(`${quoteVisibleExact(path)} is not an image or video to show.`);
            }
            const media = { kind, name: item.name, mimeType, size, sha256 };
            const story = await stories.post(ctx, scope.agent.id, call.id, caption ?? null, media);
            return { id: story.id, expiresAt: story.expiresAt };
        },
        toLLM: () => [{ type: "text", text: "Posted the story. It is live for 24 hours." }],
    });
}
