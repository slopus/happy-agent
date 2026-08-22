import { Type, type Static } from "@sinclair/typebox";

/** Bounds applied at every UsageModule storage and presentation boundary. */
/**
 * How many records one read may count.
 *
 * Usage history is kept forever, so this is a sanity bound on a counter rather than a retention
 * limit: nothing is ever deleted to satisfy it, and a read that would exceed it is a bug.
 */
export const MAX_USAGE_RECORD_COUNT = Number.MAX_SAFE_INTEGER;
/** How many groups one page may hold. */
export const MAX_USAGE_GROUPS = 500;
/**
 * How many distinct provider/model/effort/tier groups may exist behind those pages.
 *
 * Every combination an installation ever ran keeps its group forever, so this counts a collection
 * that grows rather than a page that is bounded.
 */
export const MAX_USAGE_GROUP_COUNT = Number.MAX_SAFE_INTEGER;
/**
 * How many agents one subtree snapshot may describe.
 *
 * The snapshot is walked agent by agent and rendered into one answer, so this is the size past
 * which the read is refused rather than quietly cut short and reported as complete.
 */
export const MAX_USAGE_TREE_SESSIONS = 1_000;
export const MAX_USAGE_PAGE_SIZE = 100;
export const MAX_USAGE_OUTPUT_CHARACTERS = 20_000;
export const MAX_USAGE_AGENT_ID_LENGTH = 256;
export const MAX_USAGE_PROVIDER_LENGTH = 256;
export const MAX_USAGE_MODEL_LENGTH = 512;
export const MAX_USAGE_TREE_TITLE_LENGTH = 512;
export const MAX_USAGE_TREE_PATH_LENGTH = 1_024;
export const MAX_USAGE_ID_LENGTH = 128;
export const MAX_USAGE_RUN_ID_LENGTH = 256;
export const MAX_USAGE_TOKEN_COUNT = 1_000_000_000;
export const MAX_USAGE_DURATION_MS = 31_536_000_000;
export const MAX_USAGE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_USAGE_TOTAL_TOKENS = Number.MAX_SAFE_INTEGER;
export const MAX_USAGE_TOTAL_DURATION_MS = Number.MAX_SAFE_INTEGER;

export const usageIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_ID_LENGTH,
});

export const usageRunIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_RUN_ID_LENGTH,
});

export const usageAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_AGENT_ID_LENGTH,
});

export const usageProviderSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_PROVIDER_LENGTH,
});

export const usageModelSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_MODEL_LENGTH,
});

export const usageEffortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
]);

export const usageTierSchema = Type.Literal("priority");

export const usageStateSchema = Type.Union([
    Type.Literal("cancelled"),
    Type.Literal("normal"),
    Type.Literal("tool_call"),
    Type.Literal("length"),
    Type.Literal("error"),
]);

export const usageTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_USAGE_TIMESTAMP,
});

export const usageDurationSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_USAGE_DURATION_MS,
});

export const usageTokenCountSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_USAGE_TOKEN_COUNT,
});

export const usageTokensSchema = Type.Object(
    {
        input: usageTokenCountSchema,
        output: usageTokenCountSchema,
        cacheRead: Type.Optional(usageTokenCountSchema),
        cacheWrite: Type.Optional(usageTokenCountSchema),
    },
    { additionalProperties: false },
);

const usageAttributionProperties = {
    agentId: usageAgentIdSchema,
    runId: Type.Optional(usageRunIdSchema),
    provider: usageProviderSchema,
    model: Type.Optional(usageModelSchema),
    effort: Type.Optional(usageEffortSchema),
    tier: Type.Optional(usageTierSchema),
} as const;

/** One provider response measured by Agent Base. */
export const usageInferenceRecordSchema = Type.Object(
    {
        ...usageAttributionProperties,
        id: usageIdSchema,
        kind: Type.Literal("inference"),
        state: Type.Optional(usageStateSchema),
        errorMessage: Type.Optional(Type.String({ maxLength: 2_000 })),
        tokens: usageTokensSchema,
        startedAt: usageTimestampSchema,
        finishedAt: usageTimestampSchema,
        durationMs: usageDurationSchema,
    },
    { additionalProperties: false },
);

/** One Agent Base turn, including turns that were aborted before a response was measured. */
export const usageTurnRecordSchema = Type.Object(
    {
        ...usageAttributionProperties,
        id: usageIdSchema,
        kind: Type.Literal("turn"),
        aborted: Type.Boolean(),
        contextTokens: Type.Optional(usageTokenCountSchema),
        startedAt: usageTimestampSchema,
        finishedAt: usageTimestampSchema,
        durationMs: usageDurationSchema,
    },
    { additionalProperties: false },
);

export const usageRecordSchema = Type.Union([usageInferenceRecordSchema, usageTurnRecordSchema]);

export type UsageId = Static<typeof usageIdSchema>;
export type UsageRunId = Static<typeof usageRunIdSchema>;
export type UsageAgentId = Static<typeof usageAgentIdSchema>;
export type UsageProvider = Static<typeof usageProviderSchema>;
export type UsageModel = Static<typeof usageModelSchema>;
export type UsageEffort = Static<typeof usageEffortSchema>;
export type UsageTier = Static<typeof usageTierSchema>;
export type UsageState = Static<typeof usageStateSchema>;
export type UsageTimestamp = Static<typeof usageTimestampSchema>;
export type UsageDuration = Static<typeof usageDurationSchema>;
export type UsageTokenCount = Static<typeof usageTokenCountSchema>;
export type UsageTokens = Static<typeof usageTokensSchema>;
export type UsageInferenceRecord = Static<typeof usageInferenceRecordSchema>;
export type UsageTurnRecord = Static<typeof usageTurnRecordSchema>;
export type UsageRecord = Static<typeof usageRecordSchema>;

export const usageRunTokensSchema = Type.Object(
    {
        input: Type.Integer({ minimum: 0, maximum: MAX_USAGE_TOTAL_TOKENS }),
        output: Type.Integer({ minimum: 0, maximum: MAX_USAGE_TOTAL_TOKENS }),
        cacheRead: Type.Integer({ minimum: 0, maximum: MAX_USAGE_TOTAL_TOKENS }),
        cacheWrite: Type.Integer({ minimum: 0, maximum: MAX_USAGE_TOTAL_TOKENS }),
    },
    { additionalProperties: false },
);

export const usageRunBreakdownSchema = Type.Record(
    usageProviderSchema,
    Type.Record(usageModelSchema, usageRunTokensSchema),
);

export const usageRunSummarySchema = Type.Object(
    {
        agentId: usageAgentIdSchema,
        runId: usageRunIdSchema,
        usage: usageRunBreakdownSchema,
        costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    },
    { additionalProperties: false },
);

export type UsageRunTokens = Static<typeof usageRunTokensSchema>;
export type UsageRunBreakdown = Static<typeof usageRunBreakdownSchema>;
export type UsageRunSummary = Static<typeof usageRunSummarySchema>;

/** The latest provider-measured context size for an agent or collection. */
export const usageCurrentContextSchema = Type.Object(
    {
        approximate: Type.Boolean(),
        contextTokens: usageTokenCountSchema,
        provider: usageProviderSchema,
        model: Type.Optional(usageModelSchema),
        effort: Type.Optional(usageEffortSchema),
        tier: Type.Optional(usageTierSchema),
    },
    { additionalProperties: false },
);

export type UsageCurrentContext = Static<typeof usageCurrentContextSchema>;

/** A bounded page of raw records, used by host readers that need event detail. */
export const usagePageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export const usagePageSchema = Type.Object(
    {
        agentId: usageAgentIdSchema,
        records: Type.Array(usageRecordSchema, { maxItems: MAX_USAGE_PAGE_SIZE }),
        cursor: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        totalRecords: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT })),
    },
    { additionalProperties: false },
);

export type UsagePageQuery = Static<typeof usagePageQuerySchema>;
export type UsagePage = Static<typeof usagePageSchema>;

/** A provider/model/effort/tier bucket in an aggregate usage read. */
export const usageGroupSchema = Type.Object(
    {
        provider: usageProviderSchema,
        model: Type.Optional(usageModelSchema),
        effort: Type.Optional(usageEffortSchema),
        tier: Type.Optional(usageTierSchema),
        inferenceCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        turnCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        inputTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        outputTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        totalTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        inferenceDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
        turnDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
        totalDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
    },
    { additionalProperties: false },
);

export const usageAggregateQuerySchema = Type.Object(
    {
        agentId: Type.Optional(usageAgentIdSchema),
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUP_COUNT })),
        maxGroups: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_GROUPS })),
    },
    { additionalProperties: false },
);

export const usageAgentTreeRelationSchema = Type.Union([
    Type.Literal("root"),
    Type.Literal("subagent"),
    Type.Literal("delegated"),
]);

/**
 * One agent in a subtree, as the usage module can honestly describe it.
 *
 * Every field is something the module either reads from the agent collection it was started with
 * or counts in its own records. A running agent's lifecycle status and the provider it is
 * currently configured for are the collection's business and change under the reader's feet, so
 * they are not claimed here; the provider and model a cost was actually spent on live on the
 * records themselves and are read through `readPage` or `aggregate`.
 */
export const usageAgentTreeSessionSchema = Type.Object(
    {
        agentId: usageAgentIdSchema,
        /** The agent's own title, when its metadata carries one. */
        title: Type.Optional(
            Type.String({
                maxLength: MAX_USAGE_TREE_TITLE_LENGTH,
            }),
        ),
        parentAgentId: Type.Optional(usageAgentIdSchema),
        /** The chain of agent IDs from the root of the snapshot down to this agent. */
        path: Type.String({
            minLength: 1,
            maxLength: MAX_USAGE_TREE_PATH_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
        relation: usageAgentTreeRelationSchema,
        totalTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
    },
    { additionalProperties: false },
);

/** A complete, bounded subtree rooted at the requesting agent. */
export const usageAgentTreeSchema = Type.Object(
    {
        sessions: Type.Array(usageAgentTreeSessionSchema, {
            maxItems: MAX_USAGE_TREE_SESSIONS,
        }),
        totalTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
    },
    { additionalProperties: false },
);

export type UsageAgentTreeRelation = Static<typeof usageAgentTreeRelationSchema>;
export type UsageAgentTreeSession = Static<typeof usageAgentTreeSessionSchema>;
export type UsageAgentTree = Static<typeof usageAgentTreeSchema>;

/** Totals from a bounded host-side usage aggregation. */
export const usageSummarySchema = Type.Object(
    {
        agentId: Type.Optional(usageAgentIdSchema),
        // History is unbounded, so the number of distinct groups is too. Only one page of them is
        // ever returned; MAX_USAGE_GROUPS bounds that page, not the collection behind it.
        cursor: Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUP_COUNT }),
        totalGroups: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_GROUP_COUNT,
        }),
        inferenceCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        turnCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORD_COUNT }),
        inputTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        outputTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        totalTokens: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_TOKENS,
        }),
        inferenceDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
        turnDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
        totalDurationMs: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_TOTAL_DURATION_MS,
        }),
        currentContext: Type.Optional(usageCurrentContextSchema),
        groups: Type.Array(usageGroupSchema, { maxItems: MAX_USAGE_GROUPS }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUP_COUNT })),
    },
    { additionalProperties: false },
);

export type UsageGroup = Static<typeof usageGroupSchema>;
export type UsageAggregateQuery = Static<typeof usageAggregateQuerySchema>;
export type UsageSummary = Static<typeof usageSummarySchema>;

/** A reset target is either one agent or the whole collection. */
export const usageResetTargetSchema = Type.Union([usageAgentIdSchema, Type.Null()]);

export type UsageResetTarget = Static<typeof usageResetTargetSchema>;
