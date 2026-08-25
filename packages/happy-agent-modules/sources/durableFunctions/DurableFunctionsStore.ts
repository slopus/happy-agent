import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    durableFunctionCallIdSchema,
    durableFunctionCallSchema,
    durableFunctionInvokeResultSchema,
    durableFunctionOperationIdSchema,
    durableFunctionTimestampSchema,
    type DurableFunctionCall,
} from "./DurableFunctions.js";

export const MAX_DURABLE_FUNCTION_RECOVERY_BATCH = 1_000;

export const durableFunctionContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const durableFunctionRecoveryLimitSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_DURABLE_FUNCTION_RECOVERY_BATCH,
});

export const durableFunctionRecoveryQuerySchema = Type.Union([
    Type.Object({ limit: durableFunctionRecoveryLimitSchema }, { additionalProperties: false }),
    Type.Object(
        {
            limit: durableFunctionRecoveryLimitSchema,
            afterCreatedAt: durableFunctionTimestampSchema,
            afterId: durableFunctionCallIdSchema,
        },
        { additionalProperties: false },
    ),
]);

const voidPromiseSchema = Type.Promise(Type.Void());

export const durableFunctionsStoreSchema = Type.Object(
    {
        createCall: Type.Function(
            [durableFunctionContextSchema, durableFunctionCallSchema],
            Type.Promise(durableFunctionInvokeResultSchema),
        ),
        readCall: Type.Function(
            [durableFunctionContextSchema, durableFunctionCallIdSchema],
            Type.Promise(Type.Union([durableFunctionCallSchema, Type.Undefined()])),
        ),
        readCallByOperationId: Type.Function(
            [durableFunctionContextSchema, durableFunctionOperationIdSchema],
            Type.Promise(Type.Union([durableFunctionCallSchema, Type.Undefined()])),
        ),
        listCalls: Type.Function(
            [durableFunctionContextSchema, durableFunctionRecoveryQuerySchema],
            Type.Promise(
                Type.Array(durableFunctionCallSchema, {
                    maxItems: MAX_DURABLE_FUNCTION_RECOVERY_BATCH,
                }),
            ),
        ),
        deleteCallAndState: Type.Function(
            [durableFunctionContextSchema, durableFunctionCallIdSchema],
            Type.Promise(Type.Boolean()),
        ),
        readValues: Type.Function(
            [durableFunctionContextSchema, Type.String()],
            Type.Promise(
                Type.Array(
                    Type.Object(
                        { key: Type.String(), value: Type.Unknown() },
                        { additionalProperties: false },
                    ),
                ),
            ),
        ),
        writeValue: Type.Function(
            [durableFunctionContextSchema, Type.String(), Type.Unknown()],
            voidPromiseSchema,
        ),
        writeValueIfAbsent: Type.Function(
            [durableFunctionContextSchema, Type.String(), Type.Unknown()],
            Type.Promise(Type.Boolean()),
        ),
        deleteValue: Type.Function(
            [durableFunctionContextSchema, Type.String()],
            voidPromiseSchema,
        ),
    },
    { additionalProperties: false },
);

export type DurableFunctionsStore = Static<typeof durableFunctionsStoreSchema>;
export type DurableFunctionRecoveryQuery = Static<typeof durableFunctionRecoveryQuerySchema>;

export function assertDurableFunctionsStore(
    value: unknown,
): asserts value is DurableFunctionsStore {
    if (!Value.Check(durableFunctionsStoreSchema, value)) {
        throw new Error("Durable Functions received an invalid internal storage adapter.");
    }
}

export function assertDurableFunctionCall(value: unknown): asserts value is DurableFunctionCall {
    if (!Value.Check(durableFunctionCallSchema, value)) {
        throw new Error("Durable Functions storage returned an invalid pending call.");
    }
}
