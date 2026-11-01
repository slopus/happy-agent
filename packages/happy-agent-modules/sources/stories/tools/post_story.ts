import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { Compute, ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { StoriesModule } from "../StoriesModule.js";
import { isH264Mp4 } from "../storyStore.js";

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
        replaces: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
    },
    { additionalProperties: false },
);

/** Post one image or video story on this conversation's row for a day. */
export function postStoryTool(
    stories: StoriesModule,
    computeModule: ComputeModule,
    compute: Compute,
    chatMedia: ChatMediaModule,
    scope: AgentModuleScope,
) {
    const agentId = scope.agent.id;
    return defineAgentTool({
        name: "post_story",
        defer: false,
        capabilities: [
            "Post a story to this conversation's ring when you shipped something the owner can see or try, replacing your earlier story; never for progress.",
        ],
        description: [
            "Post a story about something you shipped: an image or short H.264 .mp4 video at path, with an optional caption. It shows for 24 hours as a ring around this conversation's icon in the sidebar. For a task, only the owner sees it until they repost it to their team. A bot's story reaches non-guest team members with Stories on. Clicking the ring plays it.",
            "Post only when something real shipped that the owner can see or try: a release went out, a change was merged or pushed to main, a new build is on their phone, a page is live. Never post progress, plans, test runs, rebases, or that you started or are still working. One story per thing shipped, not per step. Most turns post nothing.",
            "Keep the ring fresh, and be aggressive about it: an old story left in the ring is noise. Every time you post, pass replaces with your earlier live story ids that the new one makes stale (up to five). They and their reposts leave as the new story is posted. At most one live story per agent. If you do not know what is live, call list_stories first. Use delete_story to remove a story without posting a new one.",
            "Show, don't tell. Pick the image or video that shows the result best, final over intermediate. When nothing worth showing has been shown yet, make something first: a screenshot or short video of it working. A caption alone is not a story. Stories are watched on a phone, so prefer a sharp, vertical image: a tall crop of the part that matters reads better than a wide screenshot shrunk to fit. To show several states or steps, record one short video instead of a series of screenshots.",
            'Write the caption for someone who is not reading the code: what changed for them, in a few plain words, such as "Stories now play on your phone" or "New test build is on your phone". No commit hashes, versions, test counts, file or branch names, or scores like "14/14" unless the person asked for them. Never invent results.',
        ].join("\n\n"),
        parameters: postStoryInputSchema,
        returnType: Type.Object({
            id: Type.String(),
            expiresAt: Type.Integer(),
            replaced: Type.Array(Type.String()),
        }),
        // The call's ID is the story's, so a replay posts nothing new.
        durable: true,
        shouldReviewInAutoMode: ({ path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, path, { write: false }),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, path, { write: false }),
        describeAutoPermissionAction: ({ path }) =>
            `posting ${quoteVisibleExact(path)} from this machine as a story for a day: only the task owner until they repost it, or non-guest team members with Stories on for a bot. Access: local file read (outside-workspace or symlink targets require full access)`,
        execute: async (ctx, { path, caption, replaces }, call) => {
            const permissions = computeModule.permissionsForContext(ctx);
            const resolved = computeModule.resolvePath(compute, path);
            const name = resolved.split(/[\\/]/u).at(-1) ?? path;
            const limit = chatMedia.limit(name);
            if (limit.kind !== "image" && !name.toLowerCase().endsWith(".mp4"))
                throw new Error("A story is an image or an H.264 .mp4 video.");
            // Measure, then check, then keep: a pipe or a file too large is never read.
            const facts = await compute.fs.stat(permissions, resolved);
            if (!facts.isFile || facts.size === 0 || facts.size > limit.maxBytes)
                throw new Error(`${quoteVisibleExact(path)} is not a file a story can show.`);
            const { maxBytes } = limit;
            const bytes = await compute.fs.readFileBuffer(permissions, resolved, { maxBytes });
            if (limit.kind === "video" && !isH264Mp4(bytes))
                throw new Error(`${quoteVisibleExact(path)} is not an H.264 MP4 video.`);
            const item = await chatMedia.snapshot(bytes, name);
            const { kind, mimeType, size, sha256 } = item;
            if (kind !== "image" && kind !== "video")
                throw new Error(`${quoteVisibleExact(path)} is not an image a story can show.`);
            const media = { kind, name: item.name, mimeType, size, sha256 };
            const story = await stories.post(
                ctx,
                agentId,
                call.id,
                caption ?? null,
                media,
                replaces,
            );
            return { id: story.id, expiresAt: story.expiresAt, replaced: story.replaced };
        },
        toLLM: ({ replaced }) => [
            {
                type: "text",
                text: `Posted the story. It is live for 24 hours. Replaced stories: ${replaced.join(", ") || "none"}.`,
            },
        ],
    });
}
