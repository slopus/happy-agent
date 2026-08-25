import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentKV } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

export const MAX_DURABLE_FUNCTION_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_DURABLE_FUNCTION_NAME_LENGTH = 256;
export const MAX_DURABLE_FUNCTION_OPERATION_ID_LENGTH = 256;
export const MAX_DURABLE_FUNCTION_LOCK_KEY_LENGTH = 256;
export const MAX_DURABLE_FUNCTION_LOCK_KEYS = 64;

/** Durable call identities are cuid2s minted by the module. */
export const durableFunctionCallIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});
export const durableFunctionNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_DURABLE_FUNCTION_NAME_LENGTH,
});
export const durableFunctionOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_DURABLE_FUNCTION_OPERATION_ID_LENGTH,
});
export const durableFunctionLockKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_DURABLE_FUNCTION_LOCK_KEY_LENGTH,
});
export const durableFunctionTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_DURABLE_FUNCTION_TIMESTAMP,
});

export const durableFunctionInvokeSchema = Type.Object(
    {
        function: durableFunctionNameSchema,
        arguments: Type.Unknown(),
        operationId: Type.Optional(durableFunctionOperationIdSchema),
        lockKeys: Type.Optional(
            Type.Array(durableFunctionLockKeySchema, { maxItems: MAX_DURABLE_FUNCTION_LOCK_KEYS }),
        ),
    },
    { additionalProperties: false },
);

export const durableFunctionInvokeResultSchema = Type.Object(
    {
        callId: durableFunctionCallIdSchema,
        status: Type.Union([Type.Literal("created"), Type.Literal("duplicate")]),
    },
    { additionalProperties: false },
);

/** One call still owed by the module. Deleting this record is how the call completes. */
export const durableFunctionCallSchema = Type.Object(
    {
        id: durableFunctionCallIdSchema,
        operationId: Type.Optional(durableFunctionOperationIdSchema),
        function: durableFunctionNameSchema,
        arguments: Type.Unknown(),
        lockKeys: Type.Array(durableFunctionLockKeySchema, {
            maxItems: MAX_DURABLE_FUNCTION_LOCK_KEYS,
        }),
        createdAt: durableFunctionTimestampSchema,
    },
    { additionalProperties: false },
);

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const opaqueAgentKVSchema = Type.Unsafe<AgentKV>(Type.Object({}, { additionalProperties: true }));
const typeBoxSchemaSchema = Type.Unsafe<TSchema>(Type.Object({}, { additionalProperties: true }));

/** The envelope common to every generic function registration. */
export const durableFunctionDefinitionSchema = Type.Object(
    {
        name: durableFunctionNameSchema,
        argumentsSchema: typeBoxSchemaSchema,
        resultSchema: typeBoxSchemaSchema,
        executor: Type.Function(
            [opaqueContextSchema, Type.Object({}, { additionalProperties: true })],
            Type.Promise(Type.Unknown()),
        ),
        onSuccess: Type.Optional(
            Type.Function(
                [opaqueContextSchema, Type.Object({}, { additionalProperties: true })],
                Type.Promise(Type.Void()),
            ),
        ),
    },
    { additionalProperties: false },
);

export function durableFunctionExecutionSchema<Arguments extends TSchema>(
    argumentsSchema: Arguments,
) {
    return Type.Object(
        {
            callId: durableFunctionCallIdSchema,
            operationId: Type.Union([durableFunctionOperationIdSchema, Type.Undefined()]),
            arguments: argumentsSchema,
            kv: opaqueAgentKVSchema,
        },
        { additionalProperties: false },
    );
}

export function durableFunctionCompletionSchema<Arguments extends TSchema, Result extends TSchema>(
    argumentsSchema: Arguments,
    resultSchema: Result,
) {
    return Type.Object(
        {
            callId: durableFunctionCallIdSchema,
            operationId: Type.Union([durableFunctionOperationIdSchema, Type.Undefined()]),
            arguments: argumentsSchema,
            result: resultSchema,
        },
        { additionalProperties: false },
    );
}

function durableFunctionExecutionValueSchema<Arguments>() {
    return Type.Object(
        {
            callId: durableFunctionCallIdSchema,
            operationId: Type.Union([durableFunctionOperationIdSchema, Type.Undefined()]),
            arguments: Type.Unsafe<Arguments>(Type.Unknown()),
            kv: opaqueAgentKVSchema,
        },
        { additionalProperties: false },
    );
}

function durableFunctionCompletionValueSchema<Arguments, Result>() {
    return Type.Object(
        {
            callId: durableFunctionCallIdSchema,
            operationId: Type.Union([durableFunctionOperationIdSchema, Type.Undefined()]),
            arguments: Type.Unsafe<Arguments>(Type.Unknown()),
            result: Type.Unsafe<Result>(Type.Unknown()),
        },
        { additionalProperties: false },
    );
}

export type DurableFunctionInvoke = Static<typeof durableFunctionInvokeSchema>;
export type DurableFunctionInvokeResult = Static<typeof durableFunctionInvokeResultSchema>;
export type DurableFunctionCall = Static<typeof durableFunctionCallSchema>;
export type DurableFunctionExecution<Arguments> = Static<
    ReturnType<typeof durableFunctionExecutionValueSchema<Arguments>>
>;
export type DurableFunctionCompletion<Arguments, Result> = Static<
    ReturnType<typeof durableFunctionCompletionValueSchema<Arguments, Result>>
>;

type DurableFunctionDefinitionEnvelope = Static<typeof durableFunctionDefinitionSchema>;

/**
 * One stable procedure known to Durable Functions.
 *
 * Executors and success handlers must be idempotent. A process may die after their external work
 * but before the completion transaction commits, in which case the executor runs again after the
 * next start. The module does not retry thrown executions in-process; an executor that wants
 * retries loops with backoff itself and honours `ctx.lifetime`.
 */
export type DurableFunctionDefinition<
    Arguments extends TSchema = TSchema,
    Result extends TSchema = TSchema,
> = Omit<
    DurableFunctionDefinitionEnvelope,
    "argumentsSchema" | "resultSchema" | "executor" | "onSuccess"
> & {
    readonly argumentsSchema: Arguments;
    readonly resultSchema: Result;
    readonly executor: (
        ctx: Context,
        call: DurableFunctionExecution<Static<Arguments>>,
    ) => Promise<Static<Result>>;
    readonly onSuccess?: (
        ctx: Context,
        call: DurableFunctionCompletion<Static<Arguments>, Static<Result>>,
    ) => Promise<void>;
};
