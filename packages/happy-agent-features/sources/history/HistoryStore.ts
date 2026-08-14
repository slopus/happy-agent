import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    historyAgentIdSchema,
    historyMessageSchema,
    MAX_HISTORY_MESSAGES_PER_APPEND,
} from "./HistoryMessage.js";
import {
    historyPageSchema,
    historyRecordSchema,
    historyStoreQuerySchema,
    type HistoryPage,
    type HistoryRecord,
    type HistoryQuery,
    type HistoryStoreQuery,
} from "./HistoryPage.js";
import { MAX_HISTORY_PAGE_SIZE } from "./HistoryMessage.js";
import { historyStatsSchema } from "./impl/summarizeHistory.js";

/*
 * Context is an extension-bearing runtime object whose enumerable string surface is intentionally
 * empty. Keep its runtime contract closed while preserving the real host-facing Context type.
 */
export const historyContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

/** Runtime contract for a host archive. */
export const historyStoreSchema = Type.Object(
    {
        append: Type.Function(
            [
                historyContextSchema,
                historyAgentIdSchema,
                Type.Array(historyMessageSchema, {
                    maxItems: MAX_HISTORY_MESSAGES_PER_APPEND,
                }),
            ],
            Type.Promise(Type.Void()),
        ),
        read: Type.Function(
            [historyContextSchema, historyAgentIdSchema, historyStoreQuerySchema],
            Type.Promise(historyPageSchema),
        ),
    },
    { additionalProperties: false },
);

/** The structural host archive contract, inferred directly from its runtime schema. */
export type HistoryStore = Static<typeof historyStoreSchema>;

const historyReaderQuerySchema = Type.Object(
    {
        from: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("start")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

/** The read-only part of history used by model handoff and other consumers. */
export const historyReaderSchema = Type.Object(
    {
        messages: Type.Function(
            [historyContextSchema, historyAgentIdSchema, historyReaderQuerySchema],
            Type.Promise(Type.Array(historyRecordSchema, { maxItems: MAX_HISTORY_PAGE_SIZE })),
        ),
        /**
         * Return exact archive statistics without exposing the archive itself. Hosts should
         * implement this as a bounded aggregate at their storage boundary.
         */
        stats: Type.Optional(
            Type.Function(
                [historyContextSchema, historyAgentIdSchema],
                Type.Promise(historyStatsSchema),
            ),
        ),
    },
    { additionalProperties: false },
);

/** The read-only history contract, inferred from its runtime schema. */
export type HistoryReader = Static<typeof historyReaderSchema>;

/** Re-export the page record types from the store-facing module. */
export type { HistoryPage, HistoryRecord, HistoryQuery, HistoryStoreQuery };
export { historyRecordSchema, historyStoreQuerySchema };
