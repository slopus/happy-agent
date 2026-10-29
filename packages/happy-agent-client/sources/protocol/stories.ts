/**
 * Stories: short, full-screen posts of what someone's work looks like. A story is a draft until
 * its author posts it, holds one to ten frames that name existing media by identity, and is drawn
 * by every client on the same 9:16 canvas with its overlays on top. Off for a person unless their
 * `happy-desktop.experiments.stories` setting is `true`.
 */

import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { userIdSchema } from "./userId.js";

/** The per-person setting that turns Stories and stickers on; only the JSON `true` enables them. */
export const STORIES_SETTING_KEY = "happy-desktop.experiments.stories";

/** The canvas every frame is drawn on, in canvas units: a 9:16 portrait phone screen. */
export const STORY_CANVAS = { width: 1080, height: 1920 } as const;
export const MAX_STORY_FRAMES = 10;
export const MAX_STORY_OVERLAYS = 32;
export const MAX_STORY_CAPTION_LENGTH = 1_024;
/** A posted story leaves the feed this long after `postedAt`. */
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long a client shows an image frame, and the most it shows of a video. */
export const STORY_IMAGE_DURATION_MS = 5_000;
export const STORY_MAX_VIDEO_DURATION_MS = 60_000;

const colorSchema = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });

/** `"draft"` until its author posts it; a story only moves forward, and deletion is final. */
export const storyStatusSchema = Type.Union([
    Type.Literal("draft"),
    Type.Literal("posted"),
    Type.Literal("deleted"),
]);
export type StoryStatus = Static<typeof storyStatusSchema>;

/** One item of a completed tool call's `media` presentation. */
export const storyChatMediaAssetSchema = Type.Object({
    type: Type.Literal("chat_media"),
    agentId: cuid2Schema,
    toolCallId: cuid2Schema,
    index: Type.Integer({ minimum: 0 }),
});

/** One image or video file of an exact, immutable artifact version, the story's own included. */
export const storyArtifactFileAssetSchema = Type.Object({
    type: Type.Literal("artifact_file"),
    artifactId: cuid2Schema,
    version: Type.Integer({ minimum: 1 }),
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
});

/**
 * An artifact itself, shown live and interactive: the asset of an `artifact` frame. Without
 * `version` it always shows the artifact's latest version.
 */
export const storyArtifactAssetSchema = Type.Object({
    type: Type.Literal("artifact"),
    artifactId: cuid2Schema,
    version: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** The media a frame shows, by identity; its bytes are never copied or uploaded again. */
export const storyAssetSchema = Type.Union([
    storyChatMediaAssetSchema,
    storyArtifactFileAssetSchema,
    storyArtifactAssetSchema,
]);
export type StoryAsset = Static<typeof storyAssetSchema>;

/** The CSS viewport an artifact frame lays out in, scaled uniformly to fill the canvas. */
export const STORY_ARTIFACT_VIEWPORT = { width: 360, height: 640 } as const;
/** How long an artifact frame shows while nobody touches it. */
export const STORY_ARTIFACT_DURATION_MS = 10_000;
export const MAX_STORY_ARTIFACT_OVERLAYS = 3;
export const MAX_STORY_ROUND_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_STORY_ROUND_VIDEO_DURATION_MS = 60_000;

/**
 * Where something sits on the canvas: its centre as fractions of the canvas from the top-left
 * corner, a size whose meaning depends on what it places, and clockwise rotation in radians.
 */
export const storyTransformSchema = Type.Object({
    x: Type.Number({ minimum: -0.5, maximum: 1.5 }),
    y: Type.Number({ minimum: -0.5, maximum: 1.5 }),
    scale: Type.Number({ minimum: 0.05, maximum: 10 }),
    rotation: Type.Number({ minimum: -Math.PI, maximum: Math.PI }),
});
export type StoryTransform = Static<typeof storyTransformSchema>;

/** Fonts clients draw with the matching system font, falling back to their own sans-serif. */
export const storyTextFontSchema = Type.Union([
    Type.Literal("sanFrancisco"),
    Type.Literal("typewriter"),
    Type.Literal("avenirNext"),
    Type.Literal("courierNew"),
    Type.Literal("noteworthy"),
    Type.Literal("georgia"),
    Type.Literal("papyrus"),
    Type.Literal("snellRoundhand"),
]);
export type StoryTextFont = Static<typeof storyTextFontSchema>;

/**
 * How a text overlay uses its colour: the text itself, a box behind it at full or half opacity,
 * an outline, or a frosted box behind white text.
 */
export const storyTextFillSchema = Type.Union([
    Type.Literal("regular"),
    Type.Literal("filled"),
    Type.Literal("semi"),
    Type.Literal("stroke"),
    Type.Literal("blur"),
]);
export type StoryTextFill = Static<typeof storyTextFillSchema>;

export const storyTextOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: 2_048 }),
    style: Type.Object({
        font: storyTextFontSchema,
        fill: storyTextFillSchema,
        color: colorSchema,
        align: Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")]),
        /** The fraction of the canvas's width the text wraps at before scaling. */
        width: Type.Number({ minimum: 0.1, maximum: 1 }),
    }),
    /** `scale` 1 is a base font size of 1/16 of the canvas's width. */
    transform: storyTransformSchema,
});
export type StoryTextOverlay = Static<typeof storyTextOverlaySchema>;

export const storyLinkStyleSchema = Type.Union([
    Type.Literal("white"),
    Type.Literal("black"),
    Type.Literal("transparent"),
    Type.Literal("blur"),
    Type.Literal("custom"),
]);
export type StoryLinkStyle = Static<typeof storyLinkStyleSchema>;

export const storyLinkOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("link"),
    /** An absolute `http` or `https` URL without a user name or password. */
    url: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" }),
    /** `null` shows the URL's host. */
    label: Nullable(Type.String({ minLength: 1, maxLength: 64 })),
    style: storyLinkStyleSchema,
    /** Present only with the `custom` style. */
    color: Type.Optional(colorSchema),
    /** `scale` 1 makes the pill 1/12 of the canvas's width tall. */
    transform: storyTransformSchema,
});
export type StoryLinkOverlay = Static<typeof storyLinkOverlaySchema>;

export const storyStickerOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("sticker"),
    packId: Type.String({ minLength: 1, maxLength: 64 }),
    stickerId: Type.String({ minLength: 1, maxLength: 128 }),
    /** `scale` is the fraction of the canvas's width the sticker's longer side takes. */
    transform: storyTransformSchema,
});
export type StoryStickerOverlay = Static<typeof storyStickerOverlaySchema>;

export const storyEmojiOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("emoji"),
    /** One emoji, a single extended grapheme cluster. */
    emoji: Type.String({ minLength: 1, maxLength: 64 }),
    transform: storyTransformSchema,
});
export type StoryEmojiOverlay = Static<typeof storyEmojiOverlaySchema>;

/** One reaction emoji, a single extended grapheme cluster. */
export const storyReactionEmojiSchema = Type.String({ minLength: 1, maxLength: 64 });

/**
 * A round speech bubble holding an emoji, which viewers tap to react with it. It shows how many
 * people reacted with that emoji.
 */
export const storyReactionOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("reaction"),
    emoji: storyReactionEmojiSchema,
    /** A dark bubble instead of the white one. */
    dark: Type.Optional(Type.Boolean()),
    /** The bubble's tail on the right instead of the left. */
    flipped: Type.Optional(Type.Boolean()),
    /** `scale` is the fraction of the canvas's width the bubble takes. */
    transform: storyTransformSchema,
});
export type StoryReactionOverlay = Static<typeof storyReactionOverlaySchema>;

/**
 * A live window onto an artifact. The page lays out 360 CSS pixels wide and `360 / aspectRatio`
 * tall; `transform.scale` is the fraction of the canvas's width the window takes.
 */
export const storyArtifactOverlaySchema = Type.Object({
    id: cuid2Schema,
    type: Type.Literal("artifact"),
    artifactId: cuid2Schema,
    /** Absent always shows the latest version. */
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    /** The window's width over its height. */
    aspectRatio: Type.Number({ minimum: 0.25, maximum: 4 }),
    transform: storyTransformSchema,
});
export type StoryArtifactOverlay = Static<typeof storyArtifactOverlaySchema>;

const storyRoundVideoFields = {
    id: cuid2Schema,
    type: Type.Literal("round_video"),
    /** Its length as the recording client measured it. */
    durationMs: Type.Integer({ minimum: 1, maximum: MAX_STORY_ROUND_VIDEO_DURATION_MS }),
    /** Flipped horizontally, for a front camera. */
    mirrored: Type.Optional(Type.Boolean()),
    /** `scale` is the circle's diameter as a fraction of the canvas's width. */
    transform: storyTransformSchema,
};

/**
 * A round video, Telegram style. Its media is a file of the story's own artifact, served by
 * `GET /v0/stories/:storyId/overlays/:overlayId/media`.
 */
export const storyRoundVideoOverlaySchema = Type.Object({
    ...storyRoundVideoFields,
    media: storyArtifactFileAssetSchema,
});
export type StoryRoundVideoOverlay = Static<typeof storyRoundVideoOverlaySchema>;

/** A new recording for a round video, from `POST /v0/artifact-uploads`. */
export const storyRoundVideoUploadSchema = Type.Object({
    type: Type.Literal("upload"),
    uploadId: cuid2Schema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
});

/** A round video in a write: a new upload, or the media it already has, sent back as read. */
export const storyRoundVideoOverlayInputSchema = Type.Object({
    ...storyRoundVideoFields,
    media: Type.Union([storyRoundVideoUploadSchema, storyArtifactFileAssetSchema]),
});
export type StoryRoundVideoOverlayInput = Static<typeof storyRoundVideoOverlayInputSchema>;

/** Drawn live by the client over the frame; a client skips a type it does not know. */
export const storyOverlaySchema = Type.Union([
    storyTextOverlaySchema,
    storyLinkOverlaySchema,
    storyStickerOverlaySchema,
    storyEmojiOverlaySchema,
    storyReactionOverlaySchema,
    storyArtifactOverlaySchema,
    storyRoundVideoOverlaySchema,
]);
export type StoryOverlay = Static<typeof storyOverlaySchema>;

/** An overlay in a write: as read, except that a round video may carry a new upload. */
export const storyOverlayInputSchema = Type.Union([
    storyTextOverlaySchema,
    storyLinkOverlaySchema,
    storyStickerOverlaySchema,
    storyEmojiOverlaySchema,
    storyReactionOverlaySchema,
    storyArtifactOverlaySchema,
    storyRoundVideoOverlayInputSchema,
]);
export type StoryOverlayInput = Static<typeof storyOverlayInputSchema>;

const storyOverlaysSchema = Type.Array(storyOverlaySchema, { maxItems: MAX_STORY_OVERLAYS });
const storyOverlayInputsSchema = Type.Array(storyOverlayInputSchema, {
    maxItems: MAX_STORY_OVERLAYS,
});

/** Two colours drawn top to bottom behind the media, filling the canvas around it. */
export const storyBackgroundSchema = Type.Tuple([colorSchema, colorSchema]);
export type StoryBackground = Static<typeof storyBackgroundSchema>;

export const storyFrameSchema = Type.Object({
    id: cuid2Schema,
    /** `"artifact"` shows a live artifact filling the canvas. */
    kind: Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("artifact")]),
    /** Pixels after EXIF orientation; `null` for a video the daemon has not measured. */
    width: Nullable(Type.Integer({ minimum: 1 })),
    height: Nullable(Type.Integer({ minimum: 1 })),
    /** Pixels per point; absent means 1. */
    scale: Type.Optional(Type.Number({ exclusiveMinimum: 1, maximum: 4 })),
    thumbhash: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    durationMs: Nullable(Type.Integer({ minimum: 0 })),
    asset: storyAssetSchema,
    /** Whether the daemon still holds the asset; an archived conversation keeps its media. */
    available: Type.Boolean(),
    /** Where the media sits on the canvas; scale 1 fits it whole. */
    placement: storyTransformSchema,
    background: storyBackgroundSchema,
    overlays: storyOverlaysSchema,
});
export type StoryFrame = Static<typeof storyFrameSchema>;

export const storyCreatorSchema = Type.Union([
    Type.Object({ kind: Type.Literal("user"), userId: Nullable(userIdSchema) }),
    Type.Object({ kind: Type.Literal("agent"), agentId: cuid2Schema }),
]);
export type StoryCreator = Static<typeof storyCreatorSchema>;

/** Whose story it is to its viewers: a person's, or an agent's in its ring. */
export const storyAuthorSchema = Type.Union([
    Type.Object({ kind: Type.Literal("user"), userId: Nullable(userIdSchema) }),
    Type.Object({ kind: Type.Literal("agent"), agentId: cuid2Schema }),
]);
export type StoryAuthor = Static<typeof storyAuthorSchema>;

/** Why an agent's story left its ring. */
export const storyEndReasonSchema = Type.Union([
    Type.Literal("superseded"),
    Type.Literal("withdrawn"),
    Type.Literal("archived"),
]);
export type StoryEndReason = Static<typeof storyEndReasonSchema>;

/** The agent's story a person's repost started from, for the "Reposted from" chip. */
export const storyRepostOfSchema = Type.Object({
    storyId: cuid2Schema,
    agentId: cuid2Schema,
    /** The agent's conversation title when it was reposted. */
    title: Nullable(Type.String({ minLength: 1, maxLength: 256 })),
    /** Whether the caller may open that conversation. */
    canOpen: Type.Boolean(),
});
export type StoryRepostOf = Static<typeof storyRepostOfSchema>;

/** How many people reacted to a story with one emoji. */
export const storyReactionCountSchema = Type.Object({
    emoji: storyReactionEmojiSchema,
    count: Type.Integer({ minimum: 1 }),
});
export type StoryReactionCount = Static<typeof storyReactionCountSchema>;

/**
 * The story object, from the caller's view: `seen`, `viewCount`, and `myReaction` are
 * caller-relative.
 */
export const storySchema = Type.Object({
    /** Also the ID of its `story` artifact. */
    id: cuid2Schema,
    status: storyStatusSchema,
    /** `null` in standalone mode. */
    authorUserId: Nullable(userIdSchema),
    createdBy: storyCreatorSchema,
    /** The conversation and tool call that drafted or posted it, or `null` for one made by hand. */
    source: Nullable(Type.Object({ agentId: cuid2Schema, toolCallId: cuid2Schema })),
    /** Agent stories: whose story it is. Older daemons omit it. */
    author: Type.Optional(storyAuthorSchema),
    /** On an agent's story, the task's or bot's agent whose ring wears it; otherwise `null`. */
    ringAgentId: Type.Optional(Nullable(cuid2Schema)),
    /** On an agent's story, the stories it ended by replacing them. */
    supersedes: Type.Optional(Type.Array(cuid2Schema)),
    /** When an agent's story left its ring, or `null` while it is in it. */
    endedAt: Type.Optional(Nullable(timestampSchema)),
    endReason: Type.Optional(Nullable(storyEndReasonSchema)),
    /** On a repost, the agent's story it started from. */
    repostOf: Type.Optional(Nullable(storyRepostOfSchema)),
    caption: Nullable(Type.String({ minLength: 1, maxLength: MAX_STORY_CAPTION_LENGTH })),
    frames: Type.Array(storyFrameSchema, { minItems: 1, maxItems: MAX_STORY_FRAMES }),
    /** Set by the daemon: every member with Stories on in team mode, the one person otherwise. */
    audience: Type.Union([Type.Literal("team"), Type.Literal("self")]),
    /** The story artifact's version this object describes. */
    artifactVersion: Type.Integer({ minimum: 1 }),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    postedAt: Nullable(timestampSchema),
    /** Exactly 24 hours after `postedAt`; always `null` on an agent's story. */
    expiresAt: Nullable(timestampSchema),
    seen: Type.Boolean(),
    /** On the author's own posted story, how many other people have seen it; otherwise `null`. */
    viewCount: Nullable(Type.Integer({ minimum: 0 })),
    /** The caller's own reaction to this posted story, or `null`. */
    myReaction: Nullable(storyReactionEmojiSchema),
    /** How many people reacted with each emoji, most first; empty on drafts. */
    reactions: Type.Array(storyReactionCountSchema),
    version: resourceVersionSchema,
});
export type Story = Static<typeof storySchema>;

/** `GET`, `PATCH`, and the action routes under `/v0/stories/:storyId`. */
export const storyResponseSchema = Type.Object({ story: storySchema });
export type StoryResponse = Static<typeof storyResponseSchema>;

/** `GET /v0/stories` query parameters. */
export interface StoriesQuery {
    /** Default `draft` and `posted`. */
    status?: readonly StoryStatus[];
    cursor?: string;
    /** 1–100, default 50. */
    limit?: number;
}

/** `GET /v0/stories` — the caller's own stories, newest first. */
export const storiesResponseSchema = Type.Object({
    stories: Type.Array(storySchema),
    nextCursor: Nullable(Type.String()),
    cursor: eventCursorSchema,
});
export type StoriesResponse = Static<typeof storiesResponseSchema>;

/** An upload from `POST /v0/artifact-uploads`, used once; its name's extension decides its kind. */
export const storyFrameUploadSchema = Type.Object({
    uploadId: cuid2Schema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
});

const storyFrameInputFields = {
    id: Type.Optional(cuid2Schema),
    placement: Type.Optional(storyTransformSchema),
    background: Type.Optional(storyBackgroundSchema),
    overlays: Type.Optional(storyOverlayInputsSchema),
};

/**
 * A frame in a write: new media from an upload or an existing asset, or, on `PATCH`, an existing
 * frame `id` alone to keep the media it has.
 */
export const storyFrameInputSchema = Type.Union([
    Type.Object({ ...storyFrameInputFields, upload: storyFrameUploadSchema }),
    Type.Object({ ...storyFrameInputFields, asset: storyAssetSchema }),
    Type.Object({ ...storyFrameInputFields, id: cuid2Schema }),
]);
export type StoryFrameInput = Static<typeof storyFrameInputSchema>;

/** `POST /v0/stories` — a draft made by hand. */
export const createStoryRequestSchema = Type.Object({
    /** Retrying with the same ID returns the story as it stands and makes nothing new. */
    id: Type.Optional(cuid2Schema),
    caption: Type.Optional(
        Nullable(Type.String({ minLength: 1, maxLength: MAX_STORY_CAPTION_LENGTH })),
    ),
    frames: Type.Array(storyFrameInputSchema, { minItems: 1, maxItems: MAX_STORY_FRAMES }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type CreateStoryRequest = Static<typeof createStoryRequestSchema>;

/** `PATCH /v0/stories/:storyId` — never changes `status`. `frames` replaces the whole list. */
export const updateStoryRequestSchema = Type.Object({
    caption: Type.Optional(
        Nullable(Type.String({ minLength: 1, maxLength: MAX_STORY_CAPTION_LENGTH })),
    ),
    frames: Type.Optional(
        Type.Array(storyFrameInputSchema, { minItems: 1, maxItems: MAX_STORY_FRAMES }),
    ),
    mutationId: Type.Optional(mutationIdSchema),
});
export type UpdateStoryRequest = Static<typeof updateStoryRequestSchema>;

/** `POST /v0/stories/:storyId/post` — the version the person saw when they pressed Post. */
export const postStoryRequestSchema = Type.Object({
    artifactVersion: Type.Integer({ minimum: 1 }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type PostStoryRequest = Static<typeof postStoryRequestSchema>;

/** `GET /v0/stories/media` query parameters. */
export interface StoryMediaQuery {
    agentId: string;
    cursor?: string;
    /** 1–100, default 30. */
    limit?: number;
}

/** One image or video a conversation presented, which the caller may put in a story. */
export const storyMediaItemSchema = Type.Object({
    asset: storyAssetSchema,
    kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
    name: Type.String({ minLength: 1, maxLength: 255 }),
    width: Nullable(Type.Integer({ minimum: 1 })),
    height: Nullable(Type.Integer({ minimum: 1 })),
    scale: Type.Optional(Type.Number({ exclusiveMinimum: 1, maximum: 4 })),
    thumbhash: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    createdAt: timestampSchema,
});
export type StoryMediaItem = Static<typeof storyMediaItemSchema>;

/** `GET /v0/stories/media` — newest first. */
export const storyMediaResponseSchema = Type.Object({
    items: Type.Array(storyMediaItemSchema),
    nextCursor: Nullable(Type.String()),
});
export type StoryMediaResponse = Static<typeof storyMediaResponseSchema>;

/** One circle of the stories row. */
export const storyFeedAuthorSchema = Type.Object({
    /** `null` for the one person in standalone mode. */
    userId: Nullable(userIdSchema),
    name: Type.String(),
    /** A daemon-relative path read with the same bearer token, or `null` for initials. */
    photo: Nullable(Type.String()),
    thumbhash: Nullable(Type.String()),
    /** Only the first author, always present: "My Story", with its "+" badge. */
    isSelf: Type.Boolean(),
    /** Posted, unexpired stories, oldest first. */
    storyIds: Type.Array(cuid2Schema),
    unseenCount: Type.Integer({ minimum: 0 }),
    /** The caller's drafts on their own circle; `null` on every other. */
    draftCount: Nullable(Type.Integer({ minimum: 0 })),
    latestPostedAt: Nullable(timestampSchema),
});
export type StoryFeedAuthor = Static<typeof storyFeedAuthorSchema>;

/** One sidebar row's ring: an agent's live stories, with its subtasks' rolled up. */
export const storyRingSchema = Type.Object({
    /** The ring's agent: match it to the sidebar row whose target `agentId` it is. */
    agentId: cuid2Schema,
    /** Live stories, oldest first. */
    storyIds: Type.Array(cuid2Schema, { minItems: 1 }),
    unseenCount: Type.Integer({ minimum: 0 }),
    latestPostedAt: timestampSchema,
});
export type StoryRing = Static<typeof storyRingSchema>;

/** `GET /v0/stories/feed` — the whole row, in the order it is shown; clients never sort again. */
export const storyFeedResponseSchema = Type.Object({
    authors: Type.Array(storyFeedAuthorSchema, { minItems: 1 }),
    /** Agent stories: rings with a live story for the caller, newest first. */
    rings: Type.Optional(Type.Array(storyRingSchema)),
    /** Every story the authors and rings name, from the caller's view. */
    stories: Type.Record(Type.String(), storySchema),
    cursor: eventCursorSchema,
});
export type StoryFeedResponse = Static<typeof storyFeedResponseSchema>;

/** `POST /v0/stories/:storyId/repost` — the caller's own draft, started from an agent's story. */
export const repostStoryRequestSchema = Type.Object({
    /** Retrying with the same ID returns the draft as it stands and makes nothing new. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type RepostStoryRequest = Static<typeof repostStoryRequestSchema>;

export const MAX_STORY_FEEDBACK_LENGTH = 8_000;

/** `POST /v0/stories/:storyId/feedback` — a message to the agent that posted it, quoting a frame. */
export const storyFeedbackRequestSchema = Type.Object({
    /** The message's ID; a repeated one sends nothing new. */
    id: Type.Optional(cuid2Schema),
    /** The frame the viewer was on; absent quotes the whole story. */
    frameId: Type.Optional(cuid2Schema),
    text: Type.String({ minLength: 1, maxLength: MAX_STORY_FEEDBACK_LENGTH }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryFeedbackRequest = Static<typeof storyFeedbackRequestSchema>;

export const storyFeedbackResponseSchema = Type.Object({
    agentId: cuid2Schema,
    messageId: cuid2Schema,
});
export type StoryFeedbackResponse = Static<typeof storyFeedbackResponseSchema>;

/** `PUT /v0/stories/:storyId/reaction` — sets or replaces the caller's one reaction. */
export const setStoryReactionRequestSchema = Type.Object({
    emoji: storyReactionEmojiSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type SetStoryReactionRequest = Static<typeof setStoryReactionRequestSchema>;

/** One person who saw the author's story, with their reaction. */
export const storyViewerSchema = Type.Object({
    userId: userIdSchema,
    name: Type.String(),
    photo: Nullable(Type.String()),
    thumbhash: Nullable(Type.String()),
    reaction: Nullable(storyReactionEmojiSchema),
    /** When they last reacted, or `null`. */
    reactedAt: Nullable(timestampSchema),
});
export type StoryViewer = Static<typeof storyViewerSchema>;

/** `GET /v0/stories/:storyId/viewers` query parameters. */
export interface StoryViewersQuery {
    cursor?: string;
    /** 1–100, default 50. */
    limit?: number;
}

/** `GET /v0/stories/:storyId/viewers` — the author's own posted story only; reactors first. */
export const storyViewersResponseSchema = Type.Object({
    viewers: Type.Array(storyViewerSchema),
    nextCursor: Nullable(Type.String()),
});
export type StoryViewersResponse = Static<typeof storyViewersResponseSchema>;

/** The moments every client plays the same haptic feedback at; the daemon never plays them. */
export const STORY_HAPTIC_MOMENTS = [
    "story.open",
    "story.advance",
    "story.post",
    "story.delete",
    "story.react",
    "sticker.drop",
    "overlay.snap",
    "overlay.trash",
] as const;
export type StoryHapticMoment = (typeof STORY_HAPTIC_MOMENTS)[number];

/** `story.created` and `story.posted`. */
export const storyEventPayloadSchema = Type.Object({
    story: storySchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryEventPayload = Static<typeof storyEventPayloadSchema>;

/** `story.updated` — the whole story, chained by version. */
export const storyUpdatedPayloadSchema = Type.Object({
    storyId: cuid2Schema,
    previousVersion: resourceVersionSchema,
    version: resourceVersionSchema,
    story: storySchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryUpdatedPayload = Static<typeof storyUpdatedPayloadSchema>;

/** `story.deleted` */
export const storyDeletedPayloadSchema = Type.Object({
    storyId: cuid2Schema,
    version: resourceVersionSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryDeletedPayload = Static<typeof storyDeletedPayloadSchema>;

/** `story.seen` — the viewer's new seen mark for that author; only the viewer receives it. */
export const storySeenPayloadSchema = Type.Object({
    authorUserId: Nullable(userIdSchema),
    storyId: cuid2Schema,
    /** For an agent's story: the ring the mark is for. */
    ringAgentId: Type.Optional(cuid2Schema),
});
export type StorySeenPayload = Static<typeof storySeenPayloadSchema>;

/** `story.ended` — an agent's story left its ring; only its person receives it. */
export const storyEndedPayloadSchema = Type.Object({
    storyId: cuid2Schema,
    version: resourceVersionSchema,
    ringAgentId: cuid2Schema,
    endedAt: timestampSchema,
    endReason: storyEndReasonSchema,
    story: storySchema,
});
export type StoryEndedPayload = Static<typeof storyEndedPayloadSchema>;

/**
 * `story.reacted` — a story's reaction counts changed. Everyone who may read the story receives
 * `reactions`; `myReaction` is present only in the copy the reacting person receives.
 */
export const storyReactedPayloadSchema = Type.Object({
    storyId: cuid2Schema,
    reactions: Type.Array(storyReactionCountSchema),
    myReaction: Type.Optional(Nullable(storyReactionEmojiSchema)),
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryReactedPayload = Static<typeof storyReactedPayloadSchema>;
