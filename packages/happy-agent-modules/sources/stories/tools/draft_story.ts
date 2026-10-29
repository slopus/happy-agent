import {
    agentPermissionMode,
    cuid2Schema,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import {
    MAX_STORY_CAPTION_LENGTH,
    MAX_STORY_FRAMES,
    MAX_STORY_OVERLAYS,
    storyTextFillSchema,
    storyTextFontSchema,
    storyTransformSchema,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { StoryInputError } from "../StoryErrors.js";
import { storyTitle } from "../impl/storyText.js";

export const colorSchema = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });
export const transformSchema = Type.Optional(
    Type.Object(storyTransformSchema.properties, {
        additionalProperties: false,
        description:
            "Where it sits on the 9:16 canvas: x and y are its centre as fractions from the top-left, scale its size, rotation in radians. Leave it out for a sensible default.",
    }),
);

export const toolOverlaySchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("text"),
            text: Type.String({ minLength: 1, maxLength: 2_048 }),
            font: Type.Optional(storyTextFontSchema),
            fill: Type.Optional(storyTextFillSchema),
            color: Type.Optional(colorSchema),
            transform: transformSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("link"),
            url: Type.String({
                minLength: 1,
                maxLength: 2_048,
                pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
            }),
            label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
            transform: transformSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("sticker"),
            packId: Type.String({ minLength: 1, maxLength: 64 }),
            stickerId: Type.String({ minLength: 1, maxLength: 128 }),
            transform: transformSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("emoji"),
            emoji: Type.String({ minLength: 1, maxLength: 64 }),
            transform: transformSchema,
        },
        { additionalProperties: false },
    ),
]);
export type DraftStoryToolOverlay = Static<typeof toolOverlaySchema>;

const draftStoryToolInputSchema = Type.Object(
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
                ]),
                {
                    minItems: 1,
                    maxItems: MAX_STORY_FRAMES,
                    description:
                        "The images or videos to show, in order: an item this conversation showed, by the tool call that showed it and its position, or an image or video file of an artifact shown here. Leave it out to use the latest one or two.",
                },
            ),
        ),
        caption: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_STORY_CAPTION_LENGTH,
                description:
                    "A short caption in the person's words, shown at the bottom of every frame.",
            }),
        ),
        overlays: Type.Optional(
            Type.Array(Type.Array(toolOverlaySchema, { maxItems: MAX_STORY_OVERLAYS }), {
                maxItems: MAX_STORY_FRAMES,
                description:
                    "Text, links, stickers, and emoji to place on each frame, by frame position.",
            }),
        ),
        storyId: Type.Optional(
            Type.String({
                ...cuid2Schema,
                description: "A draft this conversation made, to revise it.",
            }),
        ),
        baseVersion: Type.Optional(
            Type.Integer({
                minimum: 1,
                description:
                    "With storyId: the artifactVersion of the draft your revision is made against.",
            }),
        ),
    },
    { additionalProperties: false },
);
export type DraftStoryToolInput = Static<typeof draftStoryToolInputSchema>;

const draftStoryResultSchema = Type.Object(
    {
        storyId: cuid2Schema,
        artifactVersion: Type.Integer({ minimum: 1 }),
        status: Type.String(),
        frameCount: Type.Integer({ minimum: 1 }),
        presentation: Type.Object(
            {
                type: Type.Literal("artifact"),
                artifactId: cuid2Schema,
                version: Type.Integer({ minimum: 1 }),
                artifactType: Type.Literal("story"),
                title: Type.String({ minLength: 1, maxLength: 256 }),
                shows: Type.Literal("latest"),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

/** Draft a story for the conversation's person to post; nothing is ever posted by a tool. */
export function draftStoryTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "draft_story",
        defer: true,
        capabilities: [
            `Draft a story from this conversation's images and videos when the person says "post it" or asks to share what was made; it is a draft only they see until they press Post.`,
        ],
        searchKeywords: ["post it", "story", "share to stories", "draft story", "post update"],
        description: [
            'Draft a story for the person: a short full-screen post of one to ten images or videos with a caption, which their team sees once they post it. When the person says "post it", "share this", or similar, they mean this: make a draft for them to post. You never post; the draft appears in this chat with Post and Edit buttons, and nothing is shared until the person presses Post.',
            "Choose the one or two images or videos that best show the outcome the person cares about, preferring the final result over intermediate attempts. Write a short caption in the person's words, without inventing results. Without frames, the latest one or two images or videos shown in this conversation are used.",
            "To change a draft you made, call again with storyId and the baseVersion you are revising. If the person edited it since, the call fails and shows the draft as it stands: their edits win.",
        ].join("\n\n"),
        parameters: draftStoryToolInputSchema,
        returnType: draftStoryResultSchema,
        durable: true,
        // A draft is visible only to its author and nothing is posted.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: DraftStoryToolInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new StoryInputError("Read only mode cannot draft a story.");
            }
            const person = await stories.conversationPerson(ctx, scope);
            if (person === undefined) {
                throw new StoryInputError("This conversation has no person to draft a story for.");
            }
            const story = await stories.draft(ctx, {
                agentId: scope.agent.id,
                toolCallId: call.id,
                person,
                input,
            });
            return {
                storyId: story.id,
                artifactVersion: story.artifactVersion,
                status: story.status,
                frameCount: story.frames.length,
                presentation: {
                    type: "artifact" as const,
                    artifactId: story.id,
                    version: story.artifactVersion,
                    artifactType: "story" as const,
                    title: storyTitle(story.caption),
                    shows: "latest" as const,
                },
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Drafted story ${result.storyId}, version ${String(result.artifactVersion)}, with ${String(result.frameCount)} ${result.frameCount === 1 ? "frame" : "frames"}; it is ${result.status === "draft" ? "a draft" : result.status}. The person now sees it in this chat with Post and Edit, so do not show it again or describe it as posted: nothing is shared until they press Post.`,
            },
        ],
    });
}
