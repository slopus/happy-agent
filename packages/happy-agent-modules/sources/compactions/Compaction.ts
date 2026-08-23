import { Type, type Static } from "@sinclair/typebox";

export const MAX_COMPACTION_ID_LENGTH = 256;
export const MAX_COMPACTION_FAILURE_REASON_LENGTH = 8_192;
export const MAX_COMPACTION_TOKEN_COUNT = 1_000_000_000;
export const MAX_COMPACTION_PAGE_SIZE = 100;
export const DEFAULT_COMPACTION_PAGE_SIZE = 50;

export const compactionIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_COMPACTION_ID_LENGTH,
});

export const compactionTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const compactionTokenCountSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_COMPACTION_TOKEN_COUNT,
});

export const compactionTriggerSchema = Type.Union([
    Type.Literal("manual"),
    Type.Literal("automatic"),
]);

export const compactionStatusSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
]);

const compactionBaseSchema = Type.Object(
    {
        agentId: compactionIdSchema,
        id: compactionIdSchema,
        runId: compactionIdSchema,
        startedAt: compactionTimestampSchema,
        tokensBefore: Type.Optional(compactionTokenCountSchema),
        trigger: compactionTriggerSchema,
        updatedAt: compactionTimestampSchema,
        version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
);

export const runningCompactionSchema = Type.Composite(
    [compactionBaseSchema, Type.Object({ status: Type.Literal("running") })],
    { additionalProperties: false },
);

export const completedCompactionSchema = Type.Composite(
    [
        compactionBaseSchema,
        Type.Object({
            completedAt: compactionTimestampSchema,
            status: Type.Literal("completed"),
            tokensAfter: Type.Optional(compactionTokenCountSchema),
        }),
    ],
    { additionalProperties: false },
);

export const failedCompactionSchema = Type.Composite(
    [
        compactionBaseSchema,
        Type.Object({
            completedAt: compactionTimestampSchema,
            failureReason: Type.String({
                minLength: 1,
                maxLength: MAX_COMPACTION_FAILURE_REASON_LENGTH,
            }),
            status: Type.Literal("failed"),
        }),
    ],
    { additionalProperties: false },
);

export const compactionSchema = Type.Union([
    runningCompactionSchema,
    completedCompactionSchema,
    failedCompactionSchema,
]);

export type CompactionId = Static<typeof compactionIdSchema>;
export type CompactionTrigger = Static<typeof compactionTriggerSchema>;
export type CompactionStatus = Static<typeof compactionStatusSchema>;
export type RunningCompaction = Static<typeof runningCompactionSchema>;
export type CompletedCompaction = Static<typeof completedCompactionSchema>;
export type FailedCompaction = Static<typeof failedCompactionSchema>;
export type Compaction = Static<typeof compactionSchema>;

export const compactionPageQuerySchema = Type.Object(
    {
        before: Type.Optional(compactionIdSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMPACTION_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export const compactionPageSchema = Type.Object(
    {
        compactions: Type.Array(compactionSchema, { maxItems: MAX_COMPACTION_PAGE_SIZE }),
        hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type CompactionPageQuery = Static<typeof compactionPageQuerySchema>;
export type CompactionPage = Static<typeof compactionPageSchema>;

export class CompactionAlreadyRunningError extends Error {
    constructor(readonly compaction: RunningCompaction) {
        super("This agent is already compacting its context.");
        this.name = "CompactionAlreadyRunningError";
    }
}

export class CompactionAgentBusyError extends Error {
    constructor() {
        super("A working agent cannot be compacted explicitly.");
        this.name = "CompactionAgentBusyError";
    }
}
