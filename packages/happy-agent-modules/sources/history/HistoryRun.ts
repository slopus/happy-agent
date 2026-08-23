import { Type, type Static } from "@sinclair/typebox";

import {
    historyAgentIdSchema,
    historyBlockSchema,
    historyClientMetadataSchema,
    historyMessageModeSchema,
    historyMessageSchema,
    historyMutationIdSchema,
    historyRecordIdSchema,
    historyTimestampSchema,
    MAX_HISTORY_BLOCKS_PER_MESSAGE,
    MAX_HISTORY_PAGE_SIZE,
} from "./HistoryMessage.js";

export const MAX_HISTORY_PENDING_MESSAGES = 512;
export const MAX_HISTORY_MESSAGES_PER_RUN = 5_000;
export const MAX_HISTORY_RUNS_PER_PAGE = 500;

export const historyRunStatusSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("aborted"),
    Type.Literal("failed"),
]);

export const historyRunReasonSchema = Type.Union([
    Type.Literal("completed"),
    Type.Literal("steering"),
    Type.Literal("abort"),
    Type.Literal("error"),
    Type.Null(),
]);

/** One message durably waiting outside accepted conversation history. */
export const historyPendingMessageSchema = Type.Object(
    {
        id: historyRecordIdSchema,
        agentId: historyAgentIdSchema,
        role: Type.Literal("user"),
        status: Type.Literal("pending"),
        delivery: Type.Union([Type.Literal("queue"), Type.Literal("steer")]),
        createdAt: historyTimestampSchema,
        blocks: Type.Array(historyBlockSchema, { maxItems: MAX_HISTORY_BLOCKS_PER_MESSAGE }),
        mode: historyMessageModeSchema,
        clientMetadata: Type.Optional(historyClientMetadataSchema),
        mutationId: Type.Optional(historyMutationIdSchema),
        runId: Type.Null(),
    },
    { additionalProperties: false },
);

export type HistoryPendingMessage = Static<typeof historyPendingMessageSchema>;

/** Durable lifecycle metadata for one exact run, independent of whether it has messages. */
export const historyRunStateSchema = Type.Object(
    {
        id: historyRecordIdSchema,
        agentId: historyAgentIdSchema,
        status: historyRunStatusSchema,
        reason: historyRunReasonSchema,
        startedAt: historyTimestampSchema,
        endedAt: Type.Union([historyTimestampSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

export type HistoryRunState = Static<typeof historyRunStateSchema>;

/** Metadata and complete messages for one accepted run. */
export const historyRunSchema = Type.Object(
    {
        ...historyRunStateSchema.properties,
        messages: Type.Array(historyMessageSchema, {
            maxItems: MAX_HISTORY_MESSAGES_PER_RUN,
        }),
    },
    { additionalProperties: false },
);

export type HistoryRun = Static<typeof historyRunSchema>;

export const historyRunsQuerySchema = Type.Object(
    {
        before: Type.Optional(historyRecordIdSchema),
        after: Type.Optional(historyRecordIdSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTORY_PAGE_SIZE })),
        omitToolData: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export type HistoryRunsQuery = Static<typeof historyRunsQuerySchema>;

export const historyRunsPageSchema = Type.Object(
    {
        agentId: historyAgentIdSchema,
        runs: Type.Array(historyRunSchema, { maxItems: MAX_HISTORY_RUNS_PER_PAGE }),
        pending: Type.Array(historyPendingMessageSchema, {
            maxItems: MAX_HISTORY_PENDING_MESSAGES,
        }),
        hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type HistoryRunsPage = Static<typeof historyRunsPageSchema>;
