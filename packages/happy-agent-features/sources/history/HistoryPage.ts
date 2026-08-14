import { Type, type Static } from "@sinclair/typebox";

import {
    historyAgentIdSchema,
    historyQueryTextSchema,
    historyRoleSchema,
    historyMessageSchema,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TOTAL_MESSAGES,
} from "./HistoryMessage.js";
import { historyStatsSchema } from "./impl/summarizeHistory.js";

const boundedCountSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_HISTORY_TOTAL_MESSAGES,
});

/** One stored message and its stable source position. */
export const historyRecordSchema = Type.Object(
    {
        message: historyMessageSchema,
        position: Type.Integer({
            description:
                "The zero-based original position, retained when older records are pruned so cursors stay stable.",
            minimum: 0,
            maximum: MAX_HISTORY_POSITION,
        }),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyRecordSchema}. */
export type HistoryRecord = Static<typeof historyRecordSchema>;

/** A bounded statistics object returned by a history page. */
export const historyPageStatsSchema = historyStatsSchema;

/** What a reader is asking for. */
export const historyQuerySchema = Type.Object(
    {
        /** Continue from this position, which came from a previous page's cursor. */
        cursor: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: MAX_HISTORY_POSITION,
            }),
        ),
        /** Read the first matching page, or the last one. Cannot be combined with a cursor. */
        from: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("start")])),
        /** The most messages to select before the response is bounded by size. */
        limit: Type.Optional(
            Type.Integer({
                maximum: MAX_HISTORY_PAGE_SIZE,
                minimum: 1,
            }),
        ),
        /** Case-insensitive text to search the whole stored message for. */
        query: Type.Optional(historyQueryTextSchema),
        /** Return only messages in these roles. */
        roles: Type.Optional(Type.Array(historyRoleSchema, { maxItems: 4 })),
        /** Which agent to read. Omitted means the one asking. */
        target: Type.Optional(historyAgentIdSchema),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyQuerySchema}. */
export type HistoryQuery = Static<typeof historyQuerySchema>;

/** The bounded query passed to a host archive. */
export const historyStoreQuerySchema = Type.Object(
    {
        cursor: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: MAX_HISTORY_POSITION,
            }),
        ),
        from: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("start")])),
        limit: Type.Integer({
            maximum: MAX_HISTORY_PAGE_SIZE,
            minimum: 1,
        }),
        query: Type.Optional(historyQueryTextSchema),
        roles: Type.Optional(Type.Array(historyRoleSchema, { maxItems: 4 })),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyStoreQuerySchema}. */
export type HistoryStoreQuery = Static<typeof historyStoreQuerySchema>;

/** One page of history: what matched, what was selected, and how to continue. */
export const historyPageSchema = Type.Object(
    {
        /** The agent this page was read from. */
        agentId: historyAgentIdSchema,
        /** The position this page starts at. */
        cursor: Type.Integer({
            minimum: 0,
            maximum: MAX_HISTORY_POSITION,
        }),
        /** How many messages matched the filters, before the page was cut from them. */
        matchedMessages: boundedCountSchema,
        /** What those matching messages amount to. */
        matchedStats: historyPageStatsSchema,
        /** The selected messages, chronological. */
        messages: Type.Array(historyRecordSchema, {
            maxItems: MAX_HISTORY_PAGE_SIZE,
        }),
        /** Where the next page starts, absent at the end. */
        nextCursor: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: MAX_HISTORY_POSITION,
            }),
        ),
        /** Where the preceding page starts, absent at the beginning. */
        previousCursor: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: MAX_HISTORY_POSITION,
            }),
        ),
        /** How many messages the history holds in total. */
        totalMessages: boundedCountSchema,
        /** What the whole history amounts to. */
        totalStats: historyPageStatsSchema,
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyPageSchema}. */
export type HistoryPage = Static<typeof historyPageSchema>;
