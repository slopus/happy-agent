import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    slotAgentIdSchema,
    slotContentSchema,
    slotEntrySchema,
    slotIdSchema,
    slotMutationOperationSchema,
    slotNameSchema,
    slotOperationFingerprintSchema,
    slotOperationIdSchema,
    slotReorderInputSchema,
    slotScopeReferenceIdSchema,
    slotScopeReferenceSchema,
    slotDescriptionSchema,
    slotPurposeSchema,
    slotUpdateInputSchema,
    type SlotEntry,
    type SlotMutationOperation,
    type SlotOperationFingerprint,
    type SlotOperationId,
    type SlotScopeReference,
} from "./Slot.js";
import { slotEventSchema, type SlotEvent } from "./SlotEvent.js";
import {
    slotListSchema,
    slotPageQuerySchema,
    slotPageSchema,
    type SlotList,
    type SlotPage,
} from "./SlotPage.js";

/**
 * Context is owned by the host/Agent Base. It stays opaque to the feature, but
 * primitive values are rejected at the injected-boundary runtime check.
 */
const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const unknownPromiseSchema = Type.Promise(Type.Unknown());
const voidPromiseSchema = Type.Promise(Type.Void());

const slotStoreMutationRequestSchema = Type.Object(
    {
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

const slotStoreCreateBaseProperties = {
    id: slotIdSchema,
    authorAgentId: slotAgentIdSchema,
    slot: slotNameSchema,
    content: slotContentSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
} as const;

const slotStoreCreateInputSchema = Type.Union([
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("everywhere"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("project"),
            projectId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("workspace"),
            workspaceId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("session"),
            sessionId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export const slotStoreCreateResultSchema = Type.Object(
    {
        operation: Type.Literal("create"),
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
        changed: Type.Boolean(),
        entry: slotEntrySchema,
    },
    { additionalProperties: false },
);

export const slotStoreUpdateResultSchema = Type.Object(
    {
        operation: Type.Literal("update"),
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
        changed: Type.Boolean(),
        entry: slotEntrySchema,
    },
    { additionalProperties: false },
);

export const slotStoreReorderResultSchema = Type.Object(
    {
        operation: Type.Literal("reorder"),
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
        changed: Type.Boolean(),
        entryIds: slotReorderInputSchema,
        entries: Type.Array(slotEntrySchema, { maxItems: 500 }),
    },
    { additionalProperties: false },
);

export const slotStoreRemoveResultSchema = Type.Union([
    Type.Object(
        {
            operation: Type.Literal("remove"),
            operationId: slotOperationIdSchema,
            fingerprint: slotOperationFingerprintSchema,
            removed: Type.Literal(true),
            entryId: slotIdSchema,
            entry: slotEntrySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("remove"),
            operationId: slotOperationIdSchema,
            fingerprint: slotOperationFingerprintSchema,
            removed: Type.Literal(false),
            entryId: slotIdSchema,
        },
        { additionalProperties: false },
    ),
]);

/** Every host mutation returns its requested identity and its authoritative result. */
export const slotStoreMutationResultSchema = Type.Union([
    slotStoreCreateResultSchema,
    slotStoreUpdateResultSchema,
    slotStoreReorderResultSchema,
    ...slotStoreRemoveResultSchema.anyOf,
]);

/**
 * Immutable host proof for a remove mutation. Receipts describe a retryable
 * result, while this separate append-only record captures the authoritative
 * before state and outcome from the transaction that performed the remove.
 */
export const slotRemoveProofSchema = Type.Object(
    {
        agentId: slotAgentIdSchema,
        operation: Type.Literal("remove"),
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
        entryId: slotIdSchema,
        before: Type.Union([slotEntrySchema, Type.Null()]),
        removed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export const slotMutationProofSchema = Type.Union([slotRemoveProofSchema]);

/**
 * Durable host receipt. The result is retained by the host store, not in
 * feature heap state, so a retry remains meaningful after a restart.
 */
export const slotOperationReceiptSchema = Type.Object(
    {
        agentId: slotAgentIdSchema,
        operation: slotMutationOperationSchema,
        operationId: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
        result: slotStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

const transactionWorkSchema = Type.Function([opaqueContextSchema], unknownPromiseSchema);
const afterCommitCallbackSchema = Type.Function(
    [opaqueContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const slotScopeResolverSchema = Type.Function(
    [opaqueContextSchema, slotAgentIdSchema, slotScopeReferenceSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export type SlotScopeResolver = Static<typeof slotScopeResolverSchema>;

export const slotReadOperationSchema = Type.Union([Type.Literal("get"), Type.Literal("list")]);

/**
 * Optional host policy for cross-agent reads. The feature always allows self-reads; a missing
 * policy denies every other owner so read authorization cannot be inferred from the store call.
 */
export const slotReadAuthorizationSchema = Type.Function(
    [opaqueContextSchema, slotAgentIdSchema, slotAgentIdSchema, slotReadOperationSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export type SlotReadOperation = Static<typeof slotReadOperationSchema>;
export type SlotReadAuthorization = Static<typeof slotReadAuthorizationSchema>;

export const slotPublisherSchema = Type.Function(
    [opaqueContextSchema, slotEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
export type SlotPublisher = Static<typeof slotPublisherSchema>;

/**
 * Host-owned slot storage. The transaction encloses the complete
 * read-decide-write operation. `afterCommit` is deliberately synchronous:
 * registration must happen before the transaction callback returns and the
 * host decides when its outermost transaction commits. `list` receives a
 * zero-based integer offset and must return `nextCursor` equal to that offset
 * plus the number of returned entries.
 */
const slotStoreShapeSchema = Type.Object(
    {
        transaction: Type.Function(
            [opaqueContextSchema, transactionWorkSchema],
            unknownPromiseSchema,
        ),
        afterCommit: Type.Function([opaqueContextSchema, afterCommitCallbackSchema], Type.Void()),
        list: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotPageQuerySchema],
            Type.Promise(Type.Union([slotPageSchema, slotListSchema])),
        ),
        get: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotIdSchema],
            Type.Promise(Type.Union([slotEntrySchema, Type.Undefined()])),
        ),
        create: Type.Function(
            [
                opaqueContextSchema,
                slotAgentIdSchema,
                slotStoreCreateInputSchema,
                slotStoreMutationRequestSchema,
            ],
            Type.Promise(slotStoreCreateResultSchema),
        ),
        update: Type.Function(
            [
                opaqueContextSchema,
                slotAgentIdSchema,
                slotIdSchema,
                slotUpdateInputSchema,
                slotStoreMutationRequestSchema,
            ],
            Type.Promise(slotStoreUpdateResultSchema),
        ),
        reorder: Type.Function(
            [
                opaqueContextSchema,
                slotAgentIdSchema,
                slotReorderInputSchema,
                slotStoreMutationRequestSchema,
            ],
            Type.Promise(slotStoreReorderResultSchema),
        ),
        remove: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotIdSchema, slotStoreMutationRequestSchema],
            Type.Promise(slotStoreRemoveResultSchema),
        ),
        readReceipt: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotOperationIdSchema],
            Type.Promise(Type.Union([slotOperationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotOperationReceiptSchema],
            voidPromiseSchema,
        ),
        /**
         * Mutation proofs are append-only host records. A host must reject a
         * second write for the same operation unless it is byte-for-byte
         * identical, and must return the original proof from readMutationProof.
         */
        readMutationProof: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotOperationIdSchema],
            Type.Promise(Type.Union([slotMutationProofSchema, Type.Undefined()])),
        ),
        writeMutationProof: Type.Function(
            [opaqueContextSchema, slotAgentIdSchema, slotMutationProofSchema],
            voidPromiseSchema,
        ),
    },
    { additionalProperties: false },
);

/**
 * The public type is derived directly from the TypeBox contract. The
 * structural aliases only preserve useful generic callback/result types for
 * host implementations; they are not a second runtime contract.
 */
export const slotStoreSchema = slotStoreShapeSchema;
export type SlotStore = Static<typeof slotStoreSchema>;

export const slotMutationRequestSchema = slotStoreMutationRequestSchema;
export const slotStoreCreateInputContractSchema = slotStoreCreateInputSchema;

export type SlotMutationRequest = Static<typeof slotStoreMutationRequestSchema>;
export type SlotStoreCreateInput = Static<typeof slotStoreCreateInputSchema>;
export type SlotStoreCreateResult = Static<typeof slotStoreCreateResultSchema>;
export type SlotStoreUpdateResult = Static<typeof slotStoreUpdateResultSchema>;
export type SlotStoreReorderResult = Static<typeof slotStoreReorderResultSchema>;
export type SlotStoreRemoveResult = Static<typeof slotStoreRemoveResultSchema>;
export type SlotStoreMutationResult = Static<typeof slotStoreMutationResultSchema>;
export type SlotRemoveProof = Static<typeof slotRemoveProofSchema>;
export type SlotMutationProof = Static<typeof slotMutationProofSchema>;
export type SlotOperationReceipt = Static<typeof slotOperationReceiptSchema>;

export function assertSlotStore(value: unknown): asserts value is SlotStore {
    if (!Value.Check(slotStoreSchema, slotStoreValidationView(value))) {
        throw new Error("Slots feature received an invalid host store.");
    }
}

export function assertSlotStoreEntry(value: unknown): asserts value is SlotEntry {
    if (!Value.Check(slotEntrySchema, value)) {
        throw new Error("Slot store returned an invalid slot entry.");
    }
}

export function assertSlotStorePage(value: unknown): asserts value is SlotPage {
    if (!Value.Check(slotPageSchema, value)) {
        throw new Error("Slot store returned an invalid bounded slot page.");
    }
}

export function assertSlotStoreList(value: unknown): asserts value is SlotList {
    if (!Value.Check(slotListSchema, value)) {
        throw new Error("Slot store returned an invalid bounded slot list.");
    }
}

export function assertSlotStoreMutationResult(
    value: unknown,
): asserts value is SlotStoreMutationResult {
    if (!Value.Check(slotStoreMutationResultSchema, value)) {
        throw new Error("Slot store returned an invalid mutation result.");
    }
}

export function assertSlotOperationReceipt(value: unknown): asserts value is SlotOperationReceipt {
    if (!Value.Check(slotOperationReceiptSchema, value)) {
        throw new Error("Slot store returned an invalid operation receipt.");
    }
}

export function assertSlotMutationProof(value: unknown): asserts value is SlotMutationProof {
    if (!Value.Check(slotMutationProofSchema, value)) {
        throw new Error("Slot store returned an invalid immutable mutation proof.");
    }
    const proof = value as SlotMutationProof;
    if (
        proof.operation !== "remove" ||
        proof.entryId === "" ||
        proof.removed !== (proof.before !== null) ||
        (proof.before !== null && proof.before.id !== proof.entryId)
    ) {
        throw new Error("Slot remove proof has an invalid before-state marker.");
    }
}

export function assertSlotMutationRequest(value: unknown): asserts value is SlotMutationRequest {
    if (!Value.Check(slotMutationRequestSchema, value)) {
        throw new Error("Slot mutation request is invalid.");
    }
}

const slotStoreContractKeys = [
    "transaction",
    "afterCommit",
    "list",
    "get",
    "create",
    "update",
    "reorder",
    "remove",
    "readReceipt",
    "writeReceipt",
    "readMutationProof",
    "writeMutationProof",
] as const;

/** Validate prototype-backed adapters without extracting their methods at use time. */
export function slotStoreValidationView(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(slotStoreContractKeys.map((key) => [key, object[key]]));
}

/**
 * Keep these imports visible in generated declarations for hosts that use the
 * structural contracts directly.
 */
export type {
    SlotEvent,
    SlotMutationOperation,
    SlotOperationFingerprint,
    SlotOperationId,
    SlotScopeReference,
};
