import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { presenceContextSchema, presenceEventSchema, type PresenceEvent } from "./PresenceEvent.js";
import {
    presenceScheduleInputSchema,
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import { presenceStateSchema, type PresenceState } from "./PresenceState.js";

export const presenceOperationIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export const presenceFingerprintSchema = Type.String({ minLength: 1, maxLength: 4096 });

const presenceScheduleListSchema = Type.Array(presenceScheduleSchema, {
    maxItems: 10_000,
});
const presenceStateResultSchema = Type.Union([
    presenceStateSchema,
    Type.Boolean(),
    presenceScheduleSchema,
]);
const presenceMutationKindSchema = Type.Union([
    Type.Literal("set_presence"),
    Type.Literal("clear_presence"),
    Type.Literal("set_schedule"),
    Type.Literal("clear_schedule"),
]);

/**
 * The only value a host transaction may return to the feature. Keeping this shape closed means a
 * transaction adapter cannot silently substitute an arbitrary object without being rejected at
 * the feature boundary.
 */
export const presenceTransactionChangeSchema = Type.Object(
    {
        kind: presenceMutationKindSchema,
        operationId: presenceOperationIdSchema,
        result: presenceStateResultSchema,
        changed: Type.Boolean(),
        event: Type.Optional(presenceEventSchema),
    },
    { additionalProperties: false },
);

/**
 * A durable receipt makes a replay an exact no-op even if another mutation changed the configured
 * state between attempts. The host owns its persistence; the feature only supplies and validates
 * the receipt contract.
 */
export const presenceMutationReceiptSchema = Type.Object(
    {
        kind: presenceMutationKindSchema,
        operationId: presenceOperationIdSchema,
        fingerprint: presenceFingerprintSchema,
        result: presenceStateResultSchema,
    },
    { additionalProperties: false },
);

const presenceAfterCommitCallbackSchema = Type.Function(
    [presenceContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

/**
 * Optional recurring schedule persistence. The operation identity is supplied by the feature so
 * host adapters can make retries idempotent without accepting a model-provided ID.
 */
export const presenceScheduleStoreSchema = Type.Object(
    {
        list: Type.Function(
            [
                presenceContextSchema,
                Type.Object(
                    {
                        limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
                    },
                    { additionalProperties: false },
                ),
            ],
            Type.Promise(presenceScheduleListSchema),
        ),
        set: Type.Function(
            [presenceContextSchema, presenceScheduleInputSchema, presenceOperationIdSchema],
            Type.Promise(presenceScheduleSchema),
        ),
        find: Type.Function(
            [presenceContextSchema, presenceScheduleInputSchema],
            Type.Promise(Type.Union([presenceScheduleSchema, Type.Undefined()])),
        ),
        clear: Type.Function(
            [
                presenceContextSchema,
                Type.String({ minLength: 1, maxLength: 128 }),
                presenceOperationIdSchema,
            ],
            Type.Promise(Type.Boolean()),
        ),
    },
    { additionalProperties: false },
);

/**
 * Host-owned persistence and effective-state policy for presence.
 *
 * The feature never chooses a database, directory, timer, or scheduler. `read` receives the
 * feature's clock instant so a host can resolve expiry/fallback/schedules consistently inside its
 * own transaction and storage implementation.
 */
export const presenceStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [
                presenceContextSchema,
                Type.Function(
                    [presenceContextSchema],
                    Type.Promise(presenceTransactionChangeSchema),
                ),
            ],
            Type.Promise(presenceTransactionChangeSchema),
        ),
        /**
         * Registration is synchronous. The callback may itself be async because it runs after
         * commit, but returning a Promise from this registration method is a contract violation.
         */
        afterCommit: Type.Function(
            [presenceContextSchema, presenceAfterCommitCallbackSchema],
            Type.Void(),
        ),
        read: Type.Function(
            [presenceContextSchema, Type.Integer({ minimum: 0 })],
            Type.Promise(Type.Union([presenceStateSchema, Type.Undefined()])),
        ),
        readConfigured: Type.Function(
            [presenceContextSchema],
            Type.Promise(Type.Union([presenceStateSchema, Type.Undefined()])),
        ),
        set: Type.Function(
            [presenceContextSchema, presenceStateSchema, presenceOperationIdSchema],
            Type.Promise(Type.Void()),
        ),
        clear: Type.Function(
            [presenceContextSchema, presenceOperationIdSchema],
            Type.Promise(Type.Void()),
        ),
        readReceipt: Type.Function(
            [presenceContextSchema, presenceOperationIdSchema],
            Type.Promise(Type.Union([presenceMutationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [presenceContextSchema, presenceMutationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        schedule: Type.Optional(presenceScheduleStoreSchema),
    },
    { additionalProperties: false },
);

/** Every injected store contract is inferred directly from its TypeBox schema. */
export type PresenceScheduleStore = Static<typeof presenceScheduleStoreSchema>;
export type PresenceStore = Static<typeof presenceStoreSchema>;
export type PresenceTransactionChange = Static<typeof presenceTransactionChangeSchema>;
export type PresenceMutationReceipt = Static<typeof presenceMutationReceiptSchema>;

export const presenceReaderSchema = Type.Object(
    {
        read: Type.Function(
            [presenceContextSchema],
            Type.Promise(Type.Union([presenceStateSchema, Type.Undefined()])),
        ),
    },
    { additionalProperties: false },
);

/** Narrow read-only surface suitable for a future user-input/inbox feature. */
export type PresenceReader = Static<typeof presenceReaderSchema>;

export function assertPresenceTransactionChange(
    value: unknown,
): asserts value is PresenceTransactionChange {
    if (!Value.Check(presenceTransactionChangeSchema, value)) {
        throw new Error("Presence store transaction returned an invalid change.");
    }
}

export function assertPresenceMutationReceipt(
    value: unknown,
): asserts value is PresenceMutationReceipt {
    if (!Value.Check(presenceMutationReceiptSchema, value)) {
        throw new Error("Presence store returned an invalid mutation receipt.");
    }
}

export function assertPresenceStateResult(value: unknown): asserts value is PresenceState {
    if (!Value.Check(presenceStateSchema, value)) {
        throw new Error("Presence store returned an invalid presence state.");
    }
}

export function assertPresenceScheduleResult(value: unknown): asserts value is PresenceSchedule {
    if (!Value.Check(presenceScheduleSchema, value)) {
        throw new Error("Presence store returned an invalid presence schedule.");
    }
}

export function assertPresenceVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`Presence store ${operation} must return undefined.`);
    }
}

export function assertPresenceContext(value: unknown): asserts value is Context {
    if (!Value.Check(presenceContextSchema, value)) {
        throw new Error("Presence context is invalid.");
    }
}

export type { PresenceEvent, PresenceSchedule, PresenceScheduleInput, PresenceState };
