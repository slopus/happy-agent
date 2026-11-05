/**
 * Feed: one list per person of what happened on the installation. Changes to one subject the
 * person has not seen yet fold into one entry; seeing the subject closes it, so the next change
 * opens another.
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

/** What an entry is about. `task`, `bot`, `surface`, and `artifact` today; the set grows. */
export const feedSubjectTypeSchema = Type.String({ minLength: 1, maxLength: 64 });
export type FeedSubjectType = Static<typeof feedSubjectTypeSchema>;

/** The subject types this client build knows. */
export const FEED_SUBJECT_TYPES = ["task", "bot", "surface", "artifact"] as const;

export const feedSubjectSchema = Type.Object({
    type: feedSubjectTypeSchema,
    id: Type.String({ minLength: 1, maxLength: 96 }),
});
export type FeedSubject = Static<typeof feedSubjectSchema>;

/**
 * A UUIDv7 position in the Feed's own history: an entry's sort key, never an event cursor.
 */
export const feedCursorSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type FeedCursor = Static<typeof feedCursorSchema>;

/**
 * Who made a change. A person acting directly has `userId` and a `null` `agentId`; an agent's
 * change has `agentId`, with `userId` naming the person it worked for when known.
 */
export const feedActorSchema = Type.Object({
    userId: Nullable(cuid2Schema),
    agentId: Nullable(cuid2Schema),
});
export type FeedActor = Static<typeof feedActorSchema>;

/** What a change was. The set grows; treat an unknown type as a change without detail. */
export const feedChangeTypeSchema = Type.String({ minLength: 1, maxLength: 64 });
export type FeedChangeType = Static<typeof feedChangeTypeSchema>;

/** The change types this client build knows. */
export const FEED_CHANGE_TYPES = [
    "task.created",
    "bot.created",
    "surface.created",
    "todo.created",
    "document.edited",
    "artifact.created",
    "artifact.updated",
] as const;

/**
 * The newest change folded into an entry, by reference only. An entry never carries its subject's
 * title, text, or picture: clients read those from the entities they sync, so they stay current.
 * `todoId` and `seq` are absent from changes the first Feed daemons recorded. Fields may be added.
 */
export const feedLatestSchema = Type.Object({
    type: feedChangeTypeSchema,
    /** For `todo.created`: the new todo, in the entry's Surface. */
    todoId: Type.Optional(cuid2Schema),
    /** For `document.edited`: the document change that began the edit session. */
    seq: Type.Optional(Type.Integer({ minimum: 1 })),
    /** For `artifact.created` and `artifact.updated`: the version the change made. */
    artifactVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type FeedLatest = Static<typeof feedLatestSchema>;

/** One subject's folded changes, without anyone's seen state: what peeking returns. */
export const feedEntrySchema = Type.Object({
    /** The newest change folded in; entries sort newest `cursor` first. */
    cursor: feedCursorSchema,
    subject: feedSubjectSchema,
    /** The home cluster of the newest change folded in. */
    cluster: Type.String({ minLength: 1 }),
    /** Whether the subject's creation is among the folded changes. */
    created: Type.Boolean(),
    /** Further changes: new todos, document edit sessions, or artifact versions. */
    updates: Type.Integer({ minimum: 0 }),
    /** The first five distinct actors, in the order they first acted. */
    actors: Type.Array(feedActorSchema, { maxItems: 5 }),
    /** How many distinct actors are folded in. */
    actorCount: Type.Integer({ minimum: 0 }),
    /** The newest change folded in. Current daemons always send it; the first ones did not. */
    latest: Type.Optional(feedLatestSchema),
    firstAt: timestampSchema,
    lastAt: timestampSchema,
});
export type FeedEntry = Static<typeof feedEntrySchema>;

/** One entry in the caller's feed. */
export const feedItemSchema = Type.Object({
    /** A UUIDv7 minted when the entry opened; stable as the entry moves up. Key rows by it. */
    id: Type.String(),
    /** Minted at every change to the entry; of two copies, the greater is current. */
    version: resourceVersionSchema,
    ...feedEntrySchema.properties,
    /** When the caller saw it; `null` while open. */
    seenAt: Nullable(timestampSchema),
});
export type FeedItem = Static<typeof feedItemSchema>;

/** `everything` is `*`. The set grows; treat an unknown kind as an opaque name. */
export const feedClusterKindSchema = Type.String();
export type FeedClusterKind = Static<typeof feedClusterKindSchema>;

/** The caller's own choice for a cluster; `null` follows `*`. */
export const feedClusterStateSchema = Type.Union([
    Type.Literal("subscribed"),
    Type.Literal("muted"),
]);
export type FeedClusterState = Static<typeof feedClusterStateSchema>;

/** The cluster that means everything. */
export const FEED_EVERYTHING_CLUSTER = "*";

/**
 * A cluster by reference only: clients label `*` and `team` themselves and resolve the thing a
 * `<kind>:<id>` cluster names from what they sync.
 */
export const feedClusterSchema = Type.Object({
    /** `*`, `team`, or `<kind>:<id>`, such as `task:t4k8...`. */
    cluster: Type.String({ minLength: 1 }),
    kind: feedClusterKindSchema,
    /** Never `null` for `*`. */
    state: Nullable(feedClusterStateSchema),
    /** The newest retained change the caller may see, or `null`. */
    lastAt: Nullable(timestampSchema),
});
export type FeedCluster = Static<typeof feedClusterSchema>;

/** `GET /v0/feed` query parameters. */
export const feedQuerySchema = Type.Object(
    {
        /** An entry `cursor`; only older entries are listed. */
        before: Type.Optional(feedCursorSchema),
        /** 1–200, default 50. */
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        /**
         * List only entries about these subject types, such as `["artifact", "task"]`; sent as one
         * comma-separated `subjects`. An unknown type matches nothing. Daemons with
         * `capabilities.feedSubjectFilter`.
         */
        subjects: Type.Optional(Type.Array(feedSubjectTypeSchema, { maxItems: 32 })),
    },
    { additionalProperties: false },
);
export type FeedQuery = Static<typeof feedQuerySchema>;

/** `GET /v0/feed` */
export const feedResponseSchema = Type.Object({
    /** Newest `cursor` first. */
    items: Type.Array(feedItemSchema),
    /** How many of the caller's entries are open. */
    unread: Type.Integer({ minimum: 0 }),
    /** With `subjects`, how many open entries are about those types; absent without a filter. */
    filteredUnread: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Whether older entries exist beyond this page. */
    hasMore: Type.Boolean(),
    /** The event cursor captured before reading; follow `feed.*` events from it. */
    cursor: eventCursorSchema,
});
export type FeedResponse = Static<typeof feedResponseSchema>;

/** One subject to mark seen. */
export const feedSeenSubjectSchema = Type.Object(
    {
        ...feedSubjectSchema.properties,
        /** The entry `cursor` shown; a newer change keeps the entry open. */
        through: Type.Optional(feedCursorSchema),
    },
    { additionalProperties: false },
);
export type FeedSeenSubject = Static<typeof feedSeenSubjectSchema>;

/** `POST /v0/feed/seen` */
export const feedSeenRequestSchema = Type.Object(
    {
        subjects: Type.Array(feedSeenSubjectSchema, { minItems: 1, maxItems: 100 }),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
export type FeedSeenRequest = Static<typeof feedSeenRequestSchema>;

/** `POST /v0/feed/seen` response: the entries this request closed. */
export const feedSeenResponseSchema = Type.Object({
    items: Type.Array(feedItemSchema),
    unread: Type.Integer({ minimum: 0 }),
});
export type FeedSeenResponse = Static<typeof feedSeenResponseSchema>;

/** `POST /v0/feed/read-all` */
export const feedReadAllRequestSchema = Type.Object(
    {
        /** Only entries whose `cursor` is not newer close. */
        through: Type.Optional(feedCursorSchema),
        /**
         * Only entries about these subject types close. Daemons with
         * `capabilities.feedSubjectFilter`.
         */
        subjects: Type.Optional(Type.Array(feedSubjectTypeSchema, { maxItems: 32 })),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
export type FeedReadAllRequest = Static<typeof feedReadAllRequestSchema>;

/** `POST /v0/feed/read-all` response, and `feed.unread.updated`. */
export const feedUnreadSchema = Type.Object({ unread: Type.Integer({ minimum: 0 }) });
export type FeedUnread = Static<typeof feedUnreadSchema>;

/** `GET /v0/feed/clusters`: `*`, `team`, then newest `lastAt` first. */
export const feedClustersResponseSchema = Type.Object({
    clusters: Type.Array(feedClusterSchema),
});
export type FeedClustersResponse = Static<typeof feedClustersResponseSchema>;

/** `PUT` and `DELETE /v0/feed/subscriptions/:cluster` */
export const feedSubscriptionRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type FeedSubscriptionRequest = Static<typeof feedSubscriptionRequestSchema>;

/** `PUT` and `DELETE /v0/feed/subscriptions/:cluster` response. */
export const feedClusterResponseSchema = Type.Object({ cluster: feedClusterSchema });
export type FeedClusterResponse = Static<typeof feedClusterResponseSchema>;

/** `GET /v0/feed/clusters/:cluster` query parameters. */
export const feedPeekQuerySchema = Type.Object(
    {
        /** How many subjects, 1–200, default 50. */
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
);
export type FeedPeekQuery = Static<typeof feedPeekQuerySchema>;

/** `GET /v0/feed/clusters/:cluster`: the last 30 days, grouped per subject. */
export const feedPeekResponseSchema = Type.Object({
    cluster: feedClusterSchema,
    /** Newest `cursor` first. */
    entries: Type.Array(feedEntrySchema),
});
export type FeedPeekResponse = Static<typeof feedPeekResponseSchema>;

/** `feed.item.created`: an entry opened in the reader's feed. Owner-private. */
export const feedItemCreatedPayloadSchema = Type.Object({
    item: feedItemSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type FeedItemCreatedPayload = Static<typeof feedItemCreatedPayloadSchema>;

/**
 * `feed.item.updated`: an entry took in a change or was seen. A complete replacement; keep the
 * greater `version` for its `id` and re-sort by `cursor`.
 */
export const feedItemUpdatedPayloadSchema = feedItemCreatedPayloadSchema;
export type FeedItemUpdatedPayload = Static<typeof feedItemUpdatedPayloadSchema>;

/** `feed.item.removed`: the entry's subject was permanently deleted. */
export const feedItemRemovedPayloadSchema = Type.Object({ itemId: Type.String() });
export type FeedItemRemovedPayload = Static<typeof feedItemRemovedPayloadSchema>;

/** `feed.unread.updated`: the reader's count of open entries changed. */
export const feedUnreadUpdatedPayloadSchema = Type.Object({
    ...feedUnreadSchema.properties,
    mutationId: Type.Optional(mutationIdSchema),
});
export type FeedUnreadUpdatedPayload = Static<typeof feedUnreadUpdatedPayloadSchema>;
