/** Stories: images and videos a task's or bot's agent publishes for 24 hours, and reposts of them. */

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
const transform = {
    /** Scale about the layer center; omitted means 1. */
    scale: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3 })),
    /** Rotation about the layer center in degrees; omitted means 0. */
    rotation: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
};
/** Layer centers in the full media frame. Default round center is (0.2, 0.2). */
export const storyLayersSchema = Type.Object(
    {
        text: Type.Optional(
            Type.Object(
                { text: Type.String({ minLength: 1, maxLength: 200 }), ...position, ...transform },
                { additionalProperties: false },
            ),
        ),
        round: Type.Optional(
            Type.Object({ ...position, ...transform }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
export type StoryLayers = Static<typeof storyLayersSchema>;

/** The most media layers one story carries above its base media. */
export const MAX_STORY_MEDIA_LAYERS = 8;

const mediaLayerPlacement = {
    /** `round` clips the media to a circle; omitted means `rect`. */
    shape: Type.Optional(Type.Union([Type.Literal("rect"), Type.Literal("round")])),
    ...position,
    /** Width as a fraction of the frame width before `scale`. */
    width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    /** The media's width over its height, so its box is known before its bytes load. */
    aspect: Type.Number({ minimum: 0.1, maximum: 10 }),
    ...transform,
};

/** One stored image or video placed above the base media; the server never composes them. */
export const storyMediaLayerInputSchema = Type.Object(
    {
        /** A `POST /v0/artifact-uploads` upload; the daemon reads its kind from the bytes. */
        uploadId: cuid2Schema,
        ...mediaLayerPlacement,
    },
    { additionalProperties: false },
);
export type StoryMediaLayerInput = Static<typeof storyMediaLayerInputSchema>;

/**
 * A served media layer; its bytes are at `/v0/stories/:storyId/layers/:layerId`. A repost lists
 * the original's layers first, under their own IDs, then its own. A legacy round is served as the
 * layer `round`.
 */
export const storyMediaLayerSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*$" }),
    kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
    mimeType: Type.String(),
    size: Type.Integer({ minimum: 1 }),
    ...mediaLayerPlacement,
});
export type StoryMediaLayer = Static<typeof storyMediaLayerSchema>;

const mediaLayersInput = Type.Optional(
    Type.Array(storyMediaLayerInputSchema, { maxItems: MAX_STORY_MEDIA_LAYERS }),
);

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

/**
 * JSON repost body; a 16 MiB round expands to at most 22,369,624 base64 characters. Media layers
 * are the reposter's own, painted above the original's.
 */
export const storyRepostRequestSchema = Type.Object(
    {
        ...storyMetadataSchema.properties,
        mediaLayers: mediaLayersInput,
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

/** `POST /v0/stories` as JSON: every file is an upload, referenced rather than sent again. */
export const storyCreateRequestSchema = Type.Object(
    {
        ...storyMetadataSchema.properties,
        media: Type.Object({ uploadId: cuid2Schema }, { additionalProperties: false }),
        mediaLayers: mediaLayersInput,
    },
    { additionalProperties: false },
);
export type StoryCreateRequest = Static<typeof storyCreateRequestSchema>;

/** A story file staged through `POST /v0/artifact-uploads`. */
export type { ArtifactUpload as StoryUpload } from "./artifacts.js";

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
    /** Media layers above the base media in paint order. Older daemons omit it. */
    mediaLayers: Type.Optional(Type.Array(storyMediaLayerSchema)),
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
