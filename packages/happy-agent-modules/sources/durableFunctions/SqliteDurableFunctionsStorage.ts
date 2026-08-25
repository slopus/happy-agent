import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    durableFunctionCallSchema,
    durableFunctionInvokeResultSchema,
    type DurableFunctionCall,
    type DurableFunctionInvokeResult,
} from "./DurableFunctions.js";
import {
    durableFunctionRecoveryQuerySchema,
    type DurableFunctionRecoveryQuery,
    type DurableFunctionsStore,
} from "./DurableFunctionsStore.js";

/** Tables owned by DurableFunctionsModule. Keys are append-only module migrations. */
export const durableFunctionsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-durable-functions",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS durable_function_calls (
                    id TEXT PRIMARY KEY,
                    operation_id TEXT UNIQUE,
                    "function" TEXT NOT NULL,
                    arguments_json TEXT NOT NULL,
                    lock_keys_json TEXT NOT NULL,
                    created_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS durable_function_calls_created
                    ON durable_function_calls(created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS durable_function_kv (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

export function createSqliteDurableFunctionsStorage<
    Database extends AgentDatabase = AgentDatabase,
>(): DurableFunctionsStore {
    const dbFor = (ctx: Context): Database => ctx.db as Database;
    const readCall = async (
        ctx: Context,
        callId: string,
    ): Promise<DurableFunctionCall | undefined> => {
        const rows = await agentDatabaseRows<CallRow>(
            dbFor(ctx),
            sql`SELECT id, operation_id, "function" AS function_name, arguments_json,
                    lock_keys_json, created_at
                FROM durable_function_calls
                WHERE id = ${callId}
                LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : callOf(rows[0]);
    };
    const readCallByOperationId = async (
        ctx: Context,
        operationId: string,
    ): Promise<DurableFunctionCall | undefined> => {
        const rows = await agentDatabaseRows<CallRow>(
            dbFor(ctx),
            sql`SELECT id, operation_id, "function" AS function_name, arguments_json,
                    lock_keys_json, created_at
                FROM durable_function_calls
                WHERE operation_id = ${operationId}
                LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : callOf(rows[0]);
    };
    const createCall = async (
        ctx: Context,
        call: DurableFunctionCall,
    ): Promise<DurableFunctionInvokeResult> => {
        if (!Value.Check(durableFunctionCallSchema, call)) {
            throw new Error("Durable Functions tried to store an invalid pending call.");
        }
        const argumentsJson = encodeJson(call.arguments, "call arguments");
        const lockKeysJson = encodeJson(call.lockKeys, "call lock keys");
        if (call.operationId === undefined) {
            await agentDatabaseRun(
                dbFor(ctx),
                sql`INSERT INTO durable_function_calls
                    (id, operation_id, "function", arguments_json, lock_keys_json, created_at)
                    VALUES (
                        ${call.id}, NULL, ${call.function}, ${argumentsJson},
                        ${lockKeysJson}, ${call.createdAt}
                    )`,
            );
            return checkedInvokeResult({ callId: call.id, status: "created" });
        }
        const inserted = await agentDatabaseRows<{ readonly id: string }>(
            dbFor(ctx),
            sql`INSERT INTO durable_function_calls
                (id, operation_id, "function", arguments_json, lock_keys_json, created_at)
                VALUES (
                    ${call.id}, ${call.operationId}, ${call.function}, ${argumentsJson},
                    ${lockKeysJson}, ${call.createdAt}
                )
                ON CONFLICT (operation_id) DO NOTHING
                RETURNING id`,
        );
        if (inserted[0] !== undefined) {
            return checkedInvokeResult({ callId: call.id, status: "created" });
        }
        const existing = await readCallByOperationId(ctx, call.operationId);
        if (existing === undefined) {
            throw new Error("A durable function operation conflict had no pending call.");
        }
        return checkedInvokeResult({ callId: existing.id, status: "duplicate" });
    };
    const listCalls = async (
        ctx: Context,
        query: DurableFunctionRecoveryQuery,
    ): Promise<DurableFunctionCall[]> => {
        if (!Value.Check(durableFunctionRecoveryQuerySchema, query)) {
            throw new Error("Durable Functions recovery query is invalid.");
        }
        const after = !("afterCreatedAt" in query)
            ? sql``
            : sql`WHERE created_at > ${query.afterCreatedAt}
                    OR (created_at = ${query.afterCreatedAt} AND id > ${query.afterId})`;
        const rows = await agentDatabaseRows<CallRow>(
            dbFor(ctx),
            sql`SELECT id, operation_id, "function" AS function_name, arguments_json,
                    lock_keys_json, created_at
                FROM durable_function_calls
                ${after}
                ORDER BY created_at, id
                LIMIT ${query.limit}`,
        );
        return rows.map(callOf);
    };
    const deleteCallAndState = async (ctx: Context, callId: string): Promise<boolean> => {
        return await ctx.inTx(async (txCtx) => {
            if ((await readCall(txCtx, callId)) === undefined) return false;
            const prefix = callStatePrefix(callId);
            await agentDatabaseRun(
                dbFor(txCtx),
                sql`DELETE FROM durable_function_kv
                    WHERE substr(key, 1, length(${prefix})) = ${prefix}`,
            );
            await agentDatabaseRun(
                dbFor(txCtx),
                sql`DELETE FROM durable_function_calls WHERE id = ${callId}`,
            );
            return true;
        });
    };
    const readValues = async (
        ctx: Context,
        prefix: string,
    ): Promise<{ readonly key: string; readonly value: unknown }[]> => {
        const rows = await agentDatabaseRows<ValueRow>(
            dbFor(ctx),
            sql`SELECT key, value_json
                FROM durable_function_kv
                WHERE substr(key, 1, length(${prefix})) = ${prefix}
                ORDER BY key`,
        );
        return rows.map(({ key, value_json }) => checkedValue(key, value_json));
    };
    const writeValue = async (ctx: Context, key: string, value: unknown): Promise<void> => {
        const valueJson = encodeJson(value, "executor state");
        await agentDatabaseRun(
            dbFor(ctx),
            sql`INSERT INTO durable_function_kv (key, value_json)
                VALUES (${key}, ${valueJson})
                ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
        );
    };
    const writeValueIfAbsent = async (
        ctx: Context,
        key: string,
        value: unknown,
    ): Promise<boolean> => {
        const valueJson = encodeJson(value, "executor state");
        const inserted = await agentDatabaseRows<{ readonly key: string }>(
            dbFor(ctx),
            sql`INSERT INTO durable_function_kv (key, value_json)
                VALUES (${key}, ${valueJson})
                ON CONFLICT (key) DO NOTHING
                RETURNING key`,
        );
        return inserted.length > 0;
    };
    const deleteValue = async (ctx: Context, key: string): Promise<void> => {
        await agentDatabaseRun(dbFor(ctx), sql`DELETE FROM durable_function_kv WHERE key = ${key}`);
    };
    return {
        createCall,
        readCall,
        readCallByOperationId,
        listCalls,
        deleteCallAndState,
        readValues,
        writeValue,
        writeValueIfAbsent,
        deleteValue,
    };
}

type CallRow = {
    readonly id: unknown;
    readonly operation_id: unknown;
    readonly function_name: unknown;
    readonly arguments_json: unknown;
    readonly lock_keys_json: unknown;
    readonly created_at: unknown;
};

type ValueRow = {
    readonly key: unknown;
    readonly value_json: unknown;
};

const storedValueSchema = Type.Object(
    { key: Type.String(), value: Type.Unknown() },
    { additionalProperties: false },
);

function callOf(row: CallRow): DurableFunctionCall {
    const call = {
        id: row.id,
        ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
        function: row.function_name,
        arguments: parseJson(row.arguments_json, "call arguments"),
        lockKeys: parseJson(row.lock_keys_json, "call lock keys"),
        createdAt: row.created_at,
    };
    if (!Value.Check(durableFunctionCallSchema, call)) {
        throw new Error("Durable Functions database returned an invalid pending call.");
    }
    return call;
}

function checkedInvokeResult(value: unknown): DurableFunctionInvokeResult {
    if (!Value.Check(durableFunctionInvokeResultSchema, value)) {
        throw new Error("Durable Functions storage produced an invalid invoke result.");
    }
    return value;
}

function checkedValue(
    key: unknown,
    valueJson: unknown,
): { readonly key: string; readonly value: unknown } {
    const value = { key, value: parseJson(valueJson, "executor state") };
    if (!Value.Check(storedValueSchema, value)) {
        throw new Error("Durable Functions database returned invalid executor state.");
    }
    return value;
}

function encodeJson(value: unknown, label: string): string {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("undefined");
        return encoded;
    } catch {
        throw new Error(`Durable Functions ${label} is not JSON-serializable.`);
    }
}

function parseJson(value: unknown, label: string): unknown {
    if (typeof value !== "string") {
        throw new Error(`Durable Functions ${label} is not JSON text.`);
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Durable Functions ${label} contains invalid JSON.`);
    }
}

function callStatePrefix(callId: string): string {
    return `call.${callId}.`;
}
