import { Type, type Static } from "@sinclair/typebox";

/** Bounds applied at every UsageFeature storage and presentation boundary. */
export const MAX_USAGE_RECORDS = 500;
export const MAX_USAGE_GROUPS = 500;
export const MAX_USAGE_PAGE_SIZE = 100;
export const MAX_USAGE_OUTPUT_CHARACTERS = 20_000;
export const MAX_USAGE_AGENT_ID_LENGTH = 256;
export const MAX_USAGE_PROVIDER_LENGTH = 256;
export const MAX_USAGE_MODEL_LENGTH = 512;
export const MAX_USAGE_ID_LENGTH = 128;
export const MAX_USAGE_TOKEN_COUNT = 1_000_000_000;
export const MAX_USAGE_DURATION_MS = 31_536_000_000;
export const MAX_USAGE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_USAGE_TOTAL_TOKENS = MAX_USAGE_RECORDS * MAX_USAGE_TOKEN_COUNT;
export const MAX_USAGE_TOTAL_DURATION_MS = MAX_USAGE_RECORDS * MAX_USAGE_DURATION_MS;
export const MAX_USAGE_RESET_RECEIPTS = 500;
export const MAX_USAGE_RESET_RECEIPT_FINGERPRINT_LENGTH = 512;

export const usageIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_ID_LENGTH,
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
    },
    { additionalProperties: false },
);

const usageAttributionProperties = {
    agentId: usageAgentIdSchema,
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

/** A bounded page of raw records, used by host readers that need event detail. */
export const usagePageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export const usagePageSchema = Type.Object(
    {
        agentId: usageAgentIdSchema,
        records: Type.Array(usageRecordSchema, { maxItems: MAX_USAGE_PAGE_SIZE }),
        cursor: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        totalRecords: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS })),
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
        inferenceCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        turnCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
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
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUPS })),
        maxGroups: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_GROUPS })),
    },
    { additionalProperties: false },
);

/** Totals from a bounded host-side usage aggregation. */
export const usageSummarySchema = Type.Object(
    {
        agentId: Type.Optional(usageAgentIdSchema),
        cursor: Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUPS }),
        totalGroups: Type.Integer({
            minimum: 0,
            maximum: MAX_USAGE_GROUPS,
        }),
        inferenceCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        turnCount: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
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
        groups: Type.Array(usageGroupSchema, { maxItems: MAX_USAGE_GROUPS }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_USAGE_GROUPS })),
    },
    { additionalProperties: false },
);

export type UsageGroup = Static<typeof usageGroupSchema>;
export type UsageAggregateQuery = Static<typeof usageAggregateQuerySchema>;
export type UsageSummary = Static<typeof usageSummarySchema>;

/** A reset target is either one agent or the whole collection. */
export const usageResetTargetSchema = Type.Union([usageAgentIdSchema, Type.Null()]);

export const usageResetReceiptFingerprintSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USAGE_RESET_RECEIPT_FINGERPRINT_LENGTH,
});

export const usageResetReceiptSchema = Type.Object(
    {
        operationId: usageIdSchema,
        agentId: usageResetTargetSchema,
        removed: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        fingerprint: usageResetReceiptFingerprintSchema,
    },
    { additionalProperties: false },
);

export const usageResetMutationOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(usageIdSchema),
    },
    { additionalProperties: false },
);

export type UsageResetTarget = Static<typeof usageResetTargetSchema>;
export type UsageResetReceipt = Static<typeof usageResetReceiptSchema>;
export type UsageResetMutationOptions = Static<typeof usageResetMutationOptionsSchema>;
