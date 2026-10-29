import { Type, type Static } from "@sinclair/typebox";

/** The most rows one search page returns, and its size when the caller asks for none. */
export const MAX_CLEANUP_PAGE_SIZE = 50;
export const DEFAULT_CLEANUP_PAGE_SIZE = 20;
export const MAX_CLEANUP_QUERY_LENGTH = 256;

const timestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const countSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const cleanupItemKindSchema = Type.Union([
    Type.Literal("bot"),
    Type.Literal("task"),
    Type.Literal("subtask"),
    Type.Literal("project"),
    Type.Literal("workspace"),
]);
export type CleanupItemKind = Static<typeof cleanupItemKindSchema>;

export const cleanupItemStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("archived"),
]);
export type CleanupItemStatus = Static<typeof cleanupItemStatusSchema>;

export const cleanupSortSchema = Type.Union([
    Type.Literal("relevance"),
    Type.Literal("recent"),
    Type.Literal("stale"),
]);
export type CleanupSort = Static<typeof cleanupSortSchema>;

/** How many of one kind of thing sit under a row, and how many of them are still active. */
export const cleanupChildCountSchema = Type.Object(
    { total: countSchema, active: countSchema },
    { additionalProperties: false },
);

/**
 * One bot, task, subtask, project, or workspace, with what a person needs to decide whether to
 * clean it up. `lastActivityAt` rolls up everything under the row: a bot or task includes its
 * subtasks and their subagents at any depth, a workspace includes its agents and child
 * workspaces, and a project includes every workspace cut from it and every agent working in it.
 * It is never earlier than `createdAt`. `running` is true while any of them has a run open.
 */
export const cleanupItemSchema = Type.Object(
    {
        kind: cleanupItemKindSchema,
        /** The bot, task, project, or workspace ID; a subtask's is its agent ID. */
        id: Type.String({ minLength: 1 }),
        /** The conversation of a bot, task, or subtask. */
        agentId: Type.Optional(Type.String({ minLength: 1 })),
        name: Type.String(),
        status: cleanupItemStatusSchema,
        createdAt: timestampSchema,
        lastActivityAt: timestampSchema,
        running: Type.Boolean(),
        /** The team user who owns a task, and every subtask under it. */
        ownerUserId: Type.Optional(Type.String({ minLength: 1 })),
        folder: Type.Optional(Type.String({ minLength: 1 })),
        /** A workspace's branch. */
        branch: Type.Optional(Type.String({ minLength: 1 })),
        /** The project a workspace belongs to, or the bot or task a subtask works under. */
        parent: Type.Optional(
            Type.Object(
                {
                    kind: cleanupItemKindSchema,
                    id: Type.String({ minLength: 1 }),
                    name: Type.String(),
                },
                { additionalProperties: false },
            ),
        ),
        /** Subtasks at any depth under a bot, task, or subtask. */
        subtasks: Type.Optional(cleanupChildCountSchema),
        /** Workspaces in a project, or below a workspace at any depth. */
        workspaces: Type.Optional(cleanupChildCountSchema),
        /** Every agent whose activity this row rolls up, hidden subagents included. */
        agents: countSchema,
    },
    { additionalProperties: false },
);
export type CleanupItem = Static<typeof cleanupItemSchema>;

/**
 * A search over the installation. Without `query` every row matches and the default order is the
 * most recently active first. Time bounds compare against the rolled-up last activity, and a row
 * with a run open now counts as active at this moment.
 */
export const cleanupSearchQuerySchema = Type.Object(
    {
        query: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CLEANUP_QUERY_LENGTH })),
        kinds: Type.Optional(
            Type.Array(cleanupItemKindSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
        ),
        status: Type.Optional(cleanupItemStatusSchema),
        ownerUserId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
        /** Only rows with activity at or after this time. */
        activeSince: Type.Optional(timestampSchema),
        /** Only rows with no activity at or after this time. */
        inactiveSince: Type.Optional(timestampSchema),
        createdAfter: Type.Optional(timestampSchema),
        createdBefore: Type.Optional(timestampSchema),
        sort: Type.Optional(cleanupSortSchema),
        cursor: Type.Optional(countSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CLEANUP_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
export type CleanupSearchQuery = Static<typeof cleanupSearchQuerySchema>;

export const cleanupSearchResultSchema = Type.Object(
    {
        item: cleanupItemSchema,
        /** The BM25 score against `query`; absent without one. */
        score: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
);
export type CleanupSearchResult = Static<typeof cleanupSearchResultSchema>;

export const cleanupSearchPageSchema = Type.Object(
    {
        results: Type.Array(cleanupSearchResultSchema, { maxItems: MAX_CLEANUP_PAGE_SIZE }),
        sort: cleanupSortSchema,
        /** How many rows matched every filter, across all pages. */
        total: countSchema,
        cursor: countSchema,
        nextCursor: Type.Optional(countSchema),
        /** When the search read the installation; ages in the results are measured from here. */
        at: timestampSchema,
    },
    { additionalProperties: false },
);
export type CleanupSearchPage = Static<typeof cleanupSearchPageSchema>;

/** Whether an agent is working now, waiting for its next message, or archived. */
export const cleanupAgentStateSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("idle"),
    Type.Literal("archived"),
]);
export type CleanupAgentState = Static<typeof cleanupAgentStateSchema>;

/** One agent found under a row, hidden subagents included, with the folder it works in. */
export const cleanupAgentSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        state: cleanupAgentStateSchema,
        createdAt: timestampSchema,
        lastActivityAt: timestampSchema,
        folder: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type CleanupAgent = Static<typeof cleanupAgentSchema>;

/** How a row or an agent's folder relates to the folder asked about. */
export const cleanupFolderRelationSchema = Type.Union([
    /** It is that folder. */
    Type.Literal("same"),
    /** That folder is inside it. */
    Type.Literal("contains"),
    /** It is inside that folder. */
    Type.Literal("inside"),
]);
export type CleanupFolderRelation = Static<typeof cleanupFolderRelationSchema>;

/** What owns or works in one folder. */
export const cleanupFolderOwnersSchema = Type.Object(
    {
        folder: Type.String({ minLength: 1 }),
        items: Type.Array(
            Type.Object(
                { item: cleanupItemSchema, relation: cleanupFolderRelationSchema },
                { additionalProperties: false },
            ),
        ),
        agents: Type.Array(
            Type.Object(
                { agent: cleanupAgentSchema, relation: cleanupFolderRelationSchema },
                { additionalProperties: false },
            ),
        ),
        at: timestampSchema,
    },
    { additionalProperties: false },
);
export type CleanupFolderOwners = Static<typeof cleanupFolderOwnersSchema>;

/** The Happy folders a machine holds that orphan detection looks through. */
export const cleanupFolderRootKindSchema = Type.Union([
    Type.Literal("bots"),
    Type.Literal("tasks"),
    Type.Literal("workspaces"),
    Type.Literal("projects"),
]);
export type CleanupFolderRootKind = Static<typeof cleanupFolderRootKindSchema>;

/** One folder under a Happy root that no bot, task, project, or workspace record names. */
export const cleanupOrphanFolderSchema = Type.Object(
    {
        root: cleanupFolderRootKindSchema,
        folder: Type.String({ minLength: 1 }),
        /** The runner the folder is on; absent for this machine. */
        runnerId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type CleanupOrphanFolder = Static<typeof cleanupOrphanFolderSchema>;

export const MAX_CLEANUP_ORPHAN_FOLDERS = 500;

export const cleanupOrphanFoldersSchema = Type.Object(
    {
        orphans: Type.Array(cleanupOrphanFolderSchema, { maxItems: MAX_CLEANUP_ORPHAN_FOLDERS }),
        /** Each root that was looked through, or the reason it could not be. */
        roots: Type.Array(
            Type.Object(
                {
                    root: cleanupFolderRootKindSchema,
                    folder: Type.String({ minLength: 1 }),
                    runnerId: Type.Optional(Type.String({ minLength: 1 })),
                    error: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
            ),
        ),
        /** True when more orphans exist than were returned. */
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type CleanupOrphanFolders = Static<typeof cleanupOrphanFoldersSchema>;
