/**
 * Stories, protocol 34 with `capabilities.storyArtifacts`: one frame posted for a day on a task's
 * or bot's card, kept as an artifact of type `story`. Replies are messages to `replyAgentId`.
 */

import { type Static, Type } from "@sinclair/typebox";

import type { UserMessage } from "./messages.js";
import { artifactPathSchema } from "./artifacts.js";
import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    timestampSchema,
} from "./common.js";
import { taskActorSchema } from "./tasks.js";
import { userIdSchema } from "./userId.js";

export * from "./messageReplyTo.js";

/** Only the person the poster works for, or every member. */
export const storyAudienceSchema = Type.Union([Type.Literal("owner"), Type.Literal("team")]);
export type StoryAudience = Static<typeof storyAudienceSchema>;

/** Live for a day; the set may grow, and a client treats an unknown state as ended. */
export const storyStateSchema = Type.Union([
    Type.Literal("live"),
    Type.Literal("replaced"),
    Type.Literal("taken_down"),
    Type.Literal("expired"),
]);
export type StoryState = Static<typeof storyStateSchema>;

export const storyCaptionSchema = Type.String({ maxLength: 140, minLength: 1 });

/** A file of another artifact's version, its entry without `path`, or a file of the story itself. */
export const storyMediaSchema = Type.Union([
    Type.Object({
        artifactId: cuid2Schema,
        path: Type.Optional(artifactPathSchema),
        version: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({ path: artifactPathSchema }),
]);
export type StoryMedia = Static<typeof storyMediaSchema>;

/** The task's name, the bot's name, or the person's display name, as served; older daemons omit it. */
const storyPosterNameSchema = Type.Optional(Type.String({ minLength: 1 }));

/** An agent posted it, under its task or bot, or a person reposted another story. */
export const storyPosterSchema = Type.Union([
    Type.Object({
        agentId: cuid2Schema,
        botId: Nullable(cuid2Schema),
        kind: Type.Literal("agent"),
        name: storyPosterNameSchema,
        taskId: Nullable(cuid2Schema),
    }),
    Type.Object({
        kind: Type.Literal("user"),
        name: storyPosterNameSchema,
        userId: Nullable(userIdSchema),
    }),
]);
export type StoryPoster = Static<typeof storyPosterSchema>;

/** The story object. */
export const storySchema = Type.Object({
    artifactId: cuid2Schema,
    /** The version of the story artifact that holds this story. */
    artifactVersion: Type.Integer({ minimum: 1 }),
    audience: storyAudienceSchema,
    caption: Nullable(storyCaptionSchema),
    endedAt: Nullable(timestampSchema),
    expiresAt: timestampSchema,
    media: storyMediaSchema,
    postedAt: timestampSchema,
    poster: storyPosterSchema,
    /** How many replies it has; read them through the replies route. */
    replies: Type.Integer({ minimum: 0 }),
    /** Where replies go: the poster, or for a repost the original story's poster. */
    replyAgentId: cuid2Schema,
    /** The story this one reposts. */
    repostOf: Nullable(cuid2Schema),
    /** A round video of the story artifact, shown over a repost's frame. */
    round: Nullable(Type.Object({ path: artifactPathSchema })),
    /** Who opened it, oldest first; `userId` is `null` for a standalone installation's person. */
    seenBy: Type.Array(Type.Object({ seenAt: timestampSchema, userId: Nullable(userIdSchema) })),
    state: storyStateSchema,
    takenDownBy: Nullable(taskActorSchema),
});
export type Story = Static<typeof storySchema>;

/** `GET /v0/stories` — `feed`, the default, is what the caller may see live; `mine` adds ended ones. */
export const storyListScopeSchema = Type.Union([Type.Literal("feed"), Type.Literal("mine")]);
export type StoryListScope = Static<typeof storyListScopeSchema>;

/** `GET /v0/stories` — newest posted first. */
export const storyListResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    stories: Type.Array(storySchema),
});
export type StoryListResponse = Static<typeof storyListResponseSchema>;

/** Every single-story route answers with the story. */
export const storyResponseSchema = Type.Object({ story: storySchema });
export type StoryResponse = Static<typeof storyResponseSchema>;

/** `GET /v0/stories/:artifactId/replies` — newest first. */
export interface StoryRepliesResponse {
    /** The story's `replyAgentId`, whose conversation holds the replies. */
    agentId: string;
    messages: UserMessage[];
    hasMore: boolean;
}

/** `GET /v0/stories/:artifactId/replies` query parameters. */
export interface StoryRepliesQuery {
    /** The ID of the last message of the previous page. */
    before?: string;
    /** 1–100, default 50. */
    limit?: number;
}

/** `POST /v0/stories/:artifactId/seen` and `/take-down` */
export const storyMutationRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type StoryMutationRequest = Static<typeof storyMutationRequestSchema>;

/** `POST /v0/stories/:artifactId/repost` — as the caller's own story, to the team by default. */
export const repostStoryRequestSchema = Type.Object({
    audience: Type.Optional(storyAudienceSchema),
    caption: Type.Optional(storyCaptionSchema),
    /** The new story artifact's ID and the retry key. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    /** A video from `POST /v0/artifact-uploads`, placed at `path` in the new story. */
    round: Type.Optional(Type.Object({ path: artifactPathSchema, uploadId: cuid2Schema })),
});
export type RepostStoryRequest = Static<typeof repostStoryRequestSchema>;
