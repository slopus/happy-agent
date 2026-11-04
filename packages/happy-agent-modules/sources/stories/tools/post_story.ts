import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { Compute, ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { StoriesModule } from "../StoriesModule.js";
import { isH264Mp4 } from "../storyStore.js";
import { videoPoster } from "./videoPoster.js";

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
        replaces: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    },
    { additionalProperties: false },
);

/** Post one image or video story frame on this conversation's row for a day. */
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
            "Post story frames to this conversation's ring when you shipped something people can see or try; never for progress.",
        ],
        description: [
            "Post a story frame about something you shipped: an image or H.264 .mp4 video at path, with an optional caption. It is published at once to everyone who joined this task, or for a bot to non-guest team members with Stories on, for 24 hours, as a ring around this conversation's icon. Clicking the ring plays your frames in order.",
            "Post only when something real shipped that people can see or try: a release went out, a change was merged or pushed to main, a new build is on their phone, a page is live. Never post progress, plans, test runs, rebases, or that you started or are still working. Most turns post nothing.",
            "Each call posts one frame. For an update with several parts, outline it first and post one frame per part, in order, rather than combining the parts into one image or video.",
            "Keep the ring fresh: an old story left in the ring is noise. When an update makes earlier frames stale, pass their ids as replaces on the first new frame (up to twenty); they and their reposts leave as it is posted. Never replace frames of the update you are posting. If you do not know what is live, call list_stories first. Use delete_story to remove a frame without posting a new one.",
            "Show, don't tell. Pick the image or video that shows the result best, final over intermediate. When nothing worth showing has been shown yet, make something first: a screenshot or video of it working. A caption alone is not a story.",
            "The viewer is 9:16 (1080×1920). Its top 384 px are covered by the progress bar and poster, the bottom 576 px by the caption and reply field, and 48 px at each side. Content that must be fully seen should be scaled and placed inside x 48–1032, y 384–1344; prefer a vertical frame.",
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
            `posting ${quoteVisibleExact(path)} from this machine as a story for a day, seen by everyone who joined the task, or by non-guest team members with Stories on for a bot. Access: local file read (outside-workspace or symlink targets require full access)`,
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
            if (limit.kind === "video" && !(await isH264Mp4(bytes)))
                throw new Error(`${quoteVisibleExact(path)} is not an H.264 MP4 video.`);
            const item = await chatMedia.snapshot(bytes, name);
            const { kind, mimeType, size, sha256 } = item;
            if (kind !== "image" && kind !== "video")
                throw new Error(`${quoteVisibleExact(path)} is not an image a story can show.`);
            const thumbhash = item.kind === "image" ? { thumbhash: item.thumbhash } : {};
            const media = { kind, name: item.name, mimeType, size, sha256, ...thumbhash };
            const still =
                kind === "video"
                    ? await videoPoster(compute, permissions, resolved, chatMedia)
                    : undefined;
            const story = await stories.post(
                ctx,
                agentId,
                call.id,
                caption ?? null,
                media,
                replaces,
                still,
            );
            return { id: story.id, expiresAt: story.expiresAt, replaced: story.replaced };
        },
        toLLM: ({ replaced }) => [
            {
                type: "text",
                text: `Posted the story frame. It is live for 24 hours. Replaced stories: ${replaced.join(", ") || "none"}.`,
            },
        ],
    });
}
