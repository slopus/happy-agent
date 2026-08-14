import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_USAGE_RECORDS,
    MAX_USAGE_RESET_RECEIPTS,
    usageAggregateQuerySchema,
    usageAgentIdSchema,
    usagePageQuerySchema,
    usagePageSchema,
    usageRecordSchema,
    usageResetReceiptSchema,
    usageResetTargetSchema,
    usageSummarySchema,
    usageIdSchema,
} from "./Usage.js";
import { usageEventSchema } from "./UsageEvent.js";
import { usageContextSchema, usageVoidOrPromiseVoidSchema } from "./UsageContracts.js";

/*
 * A feature cannot name the concrete transaction context or the class used
 * for the host store.  Context is nevertheless structurally checked and all
 * methods have exact Promise/void result contracts.  The feature validates
 * each resolved result again before it makes a decision or publishes an
 * event.
 */
const usageAfterCommitCallbackSchema = Type.Function(
    [usageContextSchema],
    usageVoidOrPromiseVoidSchema,
);
const usageOptionalAgentIdSchema = Type.Optional(usageAgentIdSchema);
export const usageResetReceiptWriteOptionsSchema = Type.Object(
    {
        maxReceipts: Type.Integer({ minimum: 1, maximum: MAX_USAGE_RESET_RECEIPTS }),
    },
    { additionalProperties: false },
);
export const usageResetReceiptWriteResultSchema = Type.Object(
    {
        retained: Type.Integer({ minimum: 1, maximum: MAX_USAGE_RESET_RECEIPTS }),
    },
    { additionalProperties: false },
);

/**
 * Reset receipts are host-owned durable idempotency state.  A write must
 * insert the receipt and evict older receipts within the same transaction,
 * retaining no more than the requested bound.
 */

export const usageRecordStoreResultSchema = Type.Object(
    {
        operationId: usageIdSchema,
        agentId: usageAgentIdSchema,
        recordId: usageIdSchema,
        inserted: Type.Boolean(),
        record: usageRecordSchema,
    },
    { additionalProperties: false },
);

export const usageResetStoreResultSchema = Type.Object(
    {
        operationId: usageIdSchema,
        agentId: usageResetTargetSchema,
        removed: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
    },
    { additionalProperties: false },
);

export const usageRecordMutationResultSchema = Type.Object(
    {
        kind: Type.Literal("record"),
        operationId: usageIdSchema,
        agentId: usageAgentIdSchema,
        recordId: usageIdSchema,
        changed: Type.Boolean(),
        record: usageRecordSchema,
        event: Type.Optional(usageEventSchema),
    },
    { additionalProperties: false },
);

export const usageResetMutationResultSchema = Type.Object(
    {
        kind: Type.Literal("reset"),
        operationId: usageIdSchema,
        agentId: usageResetTargetSchema,
        changed: Type.Boolean(),
        removed: Type.Integer({ minimum: 0, maximum: MAX_USAGE_RECORDS }),
        event: Type.Optional(usageEventSchema),
    },
    { additionalProperties: false },
);

export const usageMutationResultSchema = Type.Union([
    usageRecordMutationResultSchema,
    usageResetMutationResultSchema,
]);

const usageTransactionWorkSchema = Type.Function(
    [usageContextSchema],
    Type.Promise(usageMutationResultSchema),
);

export type UsageRecordStoreResult = Static<typeof usageRecordStoreResultSchema>;
export type UsageResetStoreResult = Static<typeof usageResetStoreResultSchema>;
export type UsageRecordMutationResult = Static<typeof usageRecordMutationResultSchema>;
export type UsageResetMutationResult = Static<typeof usageResetMutationResultSchema>;
export type UsageMutationResult = Static<typeof usageMutationResultSchema>;
export type UsageResetReceiptWriteOptions = Static<typeof usageResetReceiptWriteOptionsSchema>;
export type UsageResetReceiptWriteResult = Static<typeof usageResetReceiptWriteResultSchema>;

/**
 * Structural host storage for usage records.
 *
 * `transaction` is the complete read/decide/write boundary.  Its callback
 * returns a closed mutation result so a malformed adapter cannot substitute a
 * different operation after the callback has completed.  `afterCommit` is
 * deliberately synchronous: registration itself is part of the transaction,
 * while the registered callback may await observer delivery.
 */
export const usageStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [usageContextSchema, usageTransactionWorkSchema],
            Type.Promise(usageMutationResultSchema),
        ),
        afterCommit: Type.Function(
            [usageContextSchema, usageAfterCommitCallbackSchema],
            Type.Void(),
        ),
        record: Type.Function(
            [usageContextSchema, usageRecordSchema],
            Type.Promise(usageRecordStoreResultSchema),
        ),
        read: Type.Function(
            [usageContextSchema, usageAgentIdSchema, usagePageQuerySchema],
            Type.Promise(usagePageSchema),
        ),
        aggregate: Type.Function(
            [usageContextSchema, usageAggregateQuerySchema],
            Type.Promise(usageSummarySchema),
        ),
        reset: Type.Function(
            [usageContextSchema, usageOptionalAgentIdSchema, usageIdSchema],
            Type.Promise(usageResetStoreResultSchema),
        ),
        readResetReceipt: Type.Function(
            [usageContextSchema, usageIdSchema],
            Type.Promise(Type.Union([usageResetReceiptSchema, Type.Undefined()])),
        ),
        writeResetReceipt: Type.Function(
            [usageContextSchema, usageResetReceiptSchema, usageResetReceiptWriteOptionsSchema],
            Type.Promise(usageResetReceiptWriteResultSchema),
        ),
    },
    { additionalProperties: false },
);

/** Every injected store contract is inferred directly from its TypeBox schema. */
export type UsageStore = Static<typeof usageStoreSchema>;

/** Runtime assertion for a host result returned from `record`. */
export function assertUsageRecordStoreResult(
    value: unknown,
): asserts value is UsageRecordStoreResult {
    if (!Value.Check(usageRecordStoreResultSchema, value)) {
        throw new Error("Usage store returned an invalid record result.");
    }
}

/** Runtime assertion for a host result returned from `reset`. */
export function assertUsageResetStoreResult(
    value: unknown,
): asserts value is UsageResetStoreResult {
    if (!Value.Check(usageResetStoreResultSchema, value)) {
        throw new Error("Usage store returned an invalid reset result.");
    }
}

/** Runtime assertion for a host transaction callback result. */
export function assertUsageMutationResult(value: unknown): asserts value is UsageMutationResult {
    if (!Value.Check(usageMutationResultSchema, value)) {
        throw new Error("Usage store transaction returned an invalid mutation result.");
    }
}

/** Runtime assertion for a reset receipt read from the host. */
export function assertUsageResetReceipt(
    value: unknown,
): asserts value is Static<typeof usageResetReceiptSchema> {
    if (!Value.Check(usageResetReceiptSchema, value)) {
        throw new Error("Usage store returned an invalid reset receipt.");
    }
}
