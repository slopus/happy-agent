/** Stories: an image or short video a task's or bot's agent posts for 24 hours, and reposts of it. */

import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema, timestampSchema } from "./common.js";

/** The user setting that turns stories on for its person; only JSON `true` does. */
export const STORIES_SETTING_KEY = "stories";

export const storyReplySchema = Type.Object({
    id: cuid2Schema,
    storyId: cuid2Schema,
    /** The person who replied; `null` standalone. */
    userId: Type.Union([cuid2Schema, Type.Null()]),
    text: Type.String({ minLength: 1, maxLength: 2000 }),
    createdAt: timestampSchema,
});
export type StoryReply = Static<typeof storyReplySchema>;

const coordinate = Type.Number({ minimum: 0, maximum: 1 });
const position = { x: coordinate, y: coordinate };
/** Layer centers in the full media frame. Default round center is (0.2, 0.2). */
export const storyLayersSchema = Type.Object(
    {
        text: Type.Optional(
            Type.Object(
                { text: Type.String({ minLength: 1, maxLength: 200 }), ...position },
                { additionalProperties: false },
            ),
        ),
        round: Type.Optional(Type.Object(position, { additionalProperties: false })),
    },
    { additionalProperties: false },
);
export type StoryLayers = Static<typeof storyLayersSchema>;

/** JSON metadata in a multipart original or repost upload. */
export const storyMetadataSchema = Type.Object(
    {
        caption: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        layers: Type.Optional(storyLayersSchema),
    },
    { additionalProperties: false },
);
export type StoryMetadata = Static<typeof storyMetadataSchema>;

export const storyReplyRequestSchema = Type.Object(
    { text: Type.String({ minLength: 1, maxLength: 2000 }) },
    { additionalProperties: false },
);
export type StoryReplyRequest = Static<typeof storyReplyRequestSchema>;

/** JSON repost body; a 16 MiB round expands to at most 22,369,624 base64 characters. */
export const storyRepostRequestSchema = Type.Object(
    {
        ...storyMetadataSchema.properties,
        round: Type.Optional(
            Type.Object(
                { data: Type.String({ minLength: 1, maxLength: 22_369_624 }) },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type StoryRepostRequest = Static<typeof storyRepostRequestSchema>;

export const storySchema = Type.Object({
    id: cuid2Schema,
    /** The chat target, including on reposts; null for a person's original story. */
    agentId: Type.Union([cuid2Schema, Type.Null()]),
    /** Exactly one for agent stories/reposts; both null for person originals. */
    taskId: Type.Union([cuid2Schema, Type.Null()]),
    botId: Type.Union([cuid2Schema, Type.Null()]),
    caption: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    media: Type.Object({
        kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
        mimeType: Type.String(),
        size: Type.Integer({ minimum: 1 }),
    }),
    postedAt: timestampSchema,
    expiresAt: timestampSchema,
    /** Whether the reader opened it; each person has their own. */
    seen: Type.Boolean(),
    /** `person` for original person stories and reposts. */
    poster: Type.Union([Type.Literal("agent"), Type.Literal("person")]),
    /** The person who posted or reposted; `null` for an agent's story or standalone. */
    userId: Type.Union([cuid2Schema, Type.Null()]),
    /** The agent story this reposts. */
    repostOf: Type.Union([cuid2Schema, Type.Null()]),
    /** The reposter's round video, served at `/v0/stories/:storyId/round`. */
    round: Type.Union([
        Type.Object({ mimeType: Type.String(), size: Type.Integer({ minimum: 1 }) }),
        Type.Null(),
    ]),
    replyCount: Type.Integer({ minimum: 0 }),
    /** The latest replies, at most two, oldest first. */
    replies: Type.Array(storyReplySchema),
    /** Whether this reader may delete it. */
    canDelete: Type.Boolean(),
    layers: Type.Optional(storyLayersSchema),
});
export type Story = Static<typeof storySchema>;

/** `story.changed`: a story was posted or the reader saw it; each reader gets their own copy. */
export interface StoryChangedPayload {
    story: Story;
}

/** `story.removed`: a story was deleted before it expired; drop it. */
export interface StoryRemovedPayload {
    storyId: string;
}
