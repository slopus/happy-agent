import {
    agentPermissionMode,
    cuid2Schema,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import {
    MAX_STORY_ARTIFACT_OVERLAYS,
    MAX_STORY_CAPTION_LENGTH,
    MAX_STORY_FRAMES,
    MAX_STORY_OVERLAYS,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { StoryInputError } from "../StoryErrors.js";
import { ringStoryLines } from "./ringStoryLines.js";
import { toolOverlaySchema, transformSchema } from "./draft_story.js";

const artifactOverlaySchema = Type.Object(
    {
        type: Type.Literal("artifact"),
        artifactId: Type.String({
            ...cuid2Schema,
            description: "An artifact shown in this conversation, to show live in a window.",
        }),
        version: Type.Optional(
            Type.Integer({
                minimum: 1,
                description: "A version to pin; leave it out to always show the latest.",
            }),
        ),
        aspectRatio: Type.Optional(
            Type.Number({
                minimum: 0.25,
                maximum: 4,
                description: "The window's width over its height; 0.8 when left out.",
            }),
        ),
        transform: transformSchema,
    },
    { additionalProperties: false },
);

const postStoryOverlaySchema = Type.Union([...toolOverlaySchema.anyOf, artifactOverlaySchema]);
export type PostStoryToolOverlay = Static<typeof postStoryOverlaySchema>;

const postStoryToolInputSchema = Type.Object(
    {
        frames: Type.Optional(
            Type.Array(
                Type.Union([
                    Type.Object(
                        {
                            toolCallId: cuid2Schema,
                            index: Type.Integer({ minimum: 0, maximum: 9 }),
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            artifactId: cuid2Schema,
                            version: Type.Integer({ minimum: 1 }),
                            path: Type.String({ minLength: 1, maxLength: 1_024 }),
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            artifactId: cuid2Schema,
                            version: Type.Optional(Type.Integer({ minimum: 1 })),
                        },
                        { additionalProperties: false },
                    ),
                ]),
                {
                    minItems: 1,
                    maxItems: MAX_STORY_FRAMES,
                    description:
                        "What to show, in order: an image or video this conversation showed, by the tool call that showed it and its position; an image or video file of an artifact shown here, with its path; or a whole artifact shown here, without a path, which fills the frame live and interactive (leave out version to always show its latest). Leave frames out to use the latest one or two images or videos.",
                },
            ),
        ),
        caption: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_STORY_CAPTION_LENGTH,
                description:
                    "What changed for the person, in a few plain words, shown at the bottom of every frame.",
            }),
        ),
        overlays: Type.Optional(
            Type.Array(
                Type.Array(postStoryOverlaySchema, {
                    maxItems: MAX_STORY_OVERLAYS,
                    description: `Text, links, stickers, emoji, and at most ${String(MAX_STORY_ARTIFACT_OVERLAYS)} live artifact windows.`,
                }),
                {
                    maxItems: MAX_STORY_FRAMES,
                    description: "What to place on each frame, by frame position.",
                },
            ),
        ),
        supersedes: Type.Optional(
            Type.Array(cuid2Schema, {
                maxItems: 20,
                description:
                    "Live stories in this ring that this one makes stale, which leave the ring as it is posted. Usually every live story: list_stories shows them.",
            }),
        ),
    },
    { additionalProperties: false },
);
export type PostStoryToolInput = Static<typeof postStoryToolInputSchema>;

const postStoryResultSchema = Type.Object(
    {
        storyId: cuid2Schema,
        frameCount: Type.Integer({ minimum: 1 }),
        superseded: Type.Array(cuid2Schema),
        live: Type.Array(Type.String()),
    },
    { additionalProperties: false },
);

/** Post an agent's story to its task's or bot's ring, for its person only. */
export function postStoryTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "post_story",
        defer: true,
        capabilities: [
            "Post a story to this task's ring in the person's sidebar when you shipped something they can see or try, replacing your earlier story; never for progress.",
        ],
        searchKeywords: ["story", "post story", "shipped", "announce", "ring", "show the person"],
        description: [
            "Post a story about something you shipped. It shows as a ring around this task's icon in the person's sidebar; only they see it, until they choose to repost it to their team. Clicking the ring plays it.",
            "Post only when something real shipped that the person can see or try: a release went out, a change was merged or pushed to main, an artifact was published, a new build is on their phone, a page is live. Never post progress, plans, test runs, rebases, or that you started or are still working. One story per thing shipped, not per step. Most turns post nothing.",
            "Keep the ring fresh, and be aggressive about it: an old story left in the ring is noise. Every time you post, pass supersedes with every live story in this ring that the new one makes stale, which is usually all of them: your own earlier story and older ones other agents of this task posted. At most one live story per agent, and for the whole task only the freshest. When unsure, supersede. Call list_stories first if you do not know what is live.",
            "Show, don't tell. Pick the one or two images or videos that show the result best, final over intermediate, or put an artifact you published in a frame or window, where the person can try it live. Without frames, the latest one or two images or videos shown in this conversation are used.",
            "A whole artifact in a frame fills a 9:16 portrait canvas. When you make an HTML page for a story frame, design it for that canvas, filling it edge to edge, and set html,body{margin:0;padding:0} so the viewer's default page inset does not frame it.",
            'Write the caption for someone who is not reading the code: what changed for them, in a few plain words, such as "Your sidebar now shows Focus\'s ideas where they apply" or "New test build is on your phone". No commit hashes, versions, test counts, file or branch names, or scores like "14/14" unless the person asked for them. Never invent results.',
        ].join("\n\n"),
        parameters: postStoryToolInputSchema,
        returnType: postStoryResultSchema,
        durable: true,
        // Only the person sees it, and nothing reaches anyone else.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: PostStoryToolInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new StoryInputError("Read only mode cannot post a story.");
            }
            const posted = await stories.postAgentStory(ctx, {
                agentId: scope.agent.id,
                toolCallId: call.id,
                input,
            });
            return {
                storyId: posted.story.id,
                frameCount: posted.story.frames.length,
                superseded: posted.story.supersedes ?? [],
                live: ringStoryLines(posted.live, scope.agent.id),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    `Posted story ${result.storyId} with ${String(result.frameCount)} ${result.frameCount === 1 ? "frame" : "frames"} to this task's ring; the person sees it in their sidebar, so do not show it again in chat.`,
                    result.superseded.length === 0
                        ? "It superseded nothing."
                        : `It superseded ${result.superseded.join(", ")}.`,
                    `Live in the ring now (${String(result.live.length)}):`,
                    ...result.live,
                    result.live.length > 1
                        ? "More than one story is live: withdraw any that went stale with withdraw_story."
                        : "",
                ]
                    .filter((line) => line.length > 0)
                    .join("\n"),
            },
        ],
    });
}
