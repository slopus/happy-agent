import {
    feedActorSchema,
    feedLatestSchema,
    feedSubjectSchema,
    type FeedEntry,
    type FeedItem,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/** Who may see a change. Only `everyone` is written today; groups come later. */
export const feedAudienceSchema = Type.Union([
    Type.Object({ kind: Type.Literal("everyone") }, { additionalProperties: false }),
    Type.Object(
        { kind: Type.Literal("users"), userIds: Type.Array(Type.String()) },
        { additionalProperties: false },
    ),
]);
export type FeedAudience = Static<typeof feedAudienceSchema>;

/** What a change in the shared log may be. */
export const feedVerbSchema = Type.Union([
    Type.Literal("task.created"),
    Type.Literal("bot.created"),
    Type.Literal("surface.created"),
    Type.Literal("todo.created"),
    Type.Literal("document.edited"),
    Type.Literal("artifact.created"),
    Type.Literal("artifact.updated"),
]);
export type FeedVerb = Static<typeof feedVerbSchema>;

/**
 * A change by reference: what it was, and the todo, document entry, or artifact version it made.
 * Never the subject's title, text, or picture; readers resolve those from the live entities.
 */
export const feedChangeLatestSchema = Type.Object(
    {
        type: feedVerbSchema,
        todoId: Type.Optional(Type.String()),
        seq: Type.Optional(Type.Integer({ minimum: 1 })),
        artifactVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);
export type FeedChangeLatest = Static<typeof feedChangeLatestSchema>;

/** One change in the shared, append-only log. Its UUIDv7 `id` is the cursor it gives entries. */
export const feedChangeSchema = Type.Object(
    {
        id: Type.String(),
        subject: feedSubjectSchema,
        latest: feedChangeLatestSchema,
        /** Every cluster the change belongs to; the last is its home cluster. */
        clusters: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        audience: feedAudienceSchema,
        actor: feedActorSchema,
        occurredAt: Type.Integer(),
    },
    { additionalProperties: false },
);
export type FeedChange = Static<typeof feedChangeSchema>;

/**
 * One subject's folded changes without a reader. `actors` holds every distinct actor in the
 * order they first acted; served entries show the first five and count them all.
 */
export const feedFoldSchema = Type.Object({
    cursor: Type.String(),
    subject: feedSubjectSchema,
    cluster: Type.String(),
    created: Type.Boolean(),
    updates: Type.Integer({ minimum: 0 }),
    actors: Type.Array(feedActorSchema),
    latest: feedLatestSchema,
    firstAt: Type.Integer(),
    lastAt: Type.Integer(),
});
export type FeedFold = Static<typeof feedFoldSchema>;

/** One entry in one reader's feed, as stored. */
export const feedItemRecordSchema = Type.Object({
    ...feedFoldSchema.properties,
    id: Type.String(),
    reader: Type.String(),
    version: Type.String(),
    seenAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type FeedItemRecord = Static<typeof feedItemRecordSchema>;

/** A subscription choice: `subscribed` or `muted`. A missing `*` choice means subscribed. */
export const feedSubscriptionStateSchema = Type.Union([
    Type.Literal("subscribed"),
    Type.Literal("muted"),
]);
export type FeedSubscriptionState = Static<typeof feedSubscriptionStateSchema>;

/** A person with a feed: a team user's ID, or the standalone installation's one person. */
export interface FeedReader {
    readonly reader: string;
    /** The newest change in the log when they joined; fan-out skips it and everything older. */
    readonly joinedCursor: string | null;
}

/** The entry a reader is served: the first five actors, and how many there are. */
export function servedFeedEntry(fold: FeedFold): FeedEntry {
    const { cursor, subject, cluster, created, updates, actors, latest, firstAt, lastAt } = fold;
    return {
        cursor,
        subject,
        cluster,
        created,
        updates,
        actors: actors.slice(0, 5),
        actorCount: actors.length,
        latest,
        firstAt,
        lastAt,
    };
}

export function servedFeedItem(record: FeedItemRecord): FeedItem {
    return {
        id: record.id,
        version: record.version,
        ...servedFeedEntry(record),
        seenAt: record.seenAt,
    };
}
