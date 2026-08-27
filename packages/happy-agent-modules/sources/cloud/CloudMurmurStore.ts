import {
    MAXIMUM_STORE_SCAN_ITEMS,
    type MurmurStore,
    type StoreScanOptions,
    type StoreTransaction,
} from "@slopus/murmur";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { CloudKeysAccount } from "./CloudKeysDatabase.js";

export const CLOUD_MURMUR_STORE_MIGRATION_KEY = "004-cloud-murmur-store";

const CLOUD_MURMUR_STORE_TABLE = "happy_agent_cloud_murmur_store";
const MAXIMUM_KEY_CHARACTERS = 4_096;
const MAXIMUM_VALUE_BYTES = 32 * 1_024 * 1_024;

export const cloudMurmurStoreMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_MURMUR_STORE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_MURMUR_STORE_TABLE)} (
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    store_key TEXT NOT NULL COLLATE BINARY,
                    value_bytes BLOB NOT NULL,
                    PRIMARY KEY (environment, user_id, store_key)
                )`,
            );
        },
    ],
];

/** SQLite-backed, account-scoped Murmur store using the Cloud module's owned context. */
export class CloudMurmurStore implements MurmurStore {
    readonly #account: CloudKeysAccount;
    readonly #ctx: Context;
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });

    constructor(ctx: Context, account: CloudKeysAccount) {
        this.#ctx = ctx;
        this.#account = account;
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        return await this.#lock.runInLock(this.#ctx, async () => {
            return await this.#ctx.inTx(async (txCtx) => await this.#get(txCtx, key));
        });
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        await this.#lock.runInLock(this.#ctx, async () => {
            await this.#ctx.inTx(async (txCtx) => await this.#set(txCtx, key, value));
        });
    }

    async delete(key: string): Promise<void> {
        await this.#lock.runInLock(this.#ctx, async () => {
            await this.#ctx.inTx(async (txCtx) => await this.#delete(txCtx, key));
        });
    }

    /** Removes every durable Murmur value owned by this Cloud account. */
    async clear(): Promise<void> {
        await this.#lock.runInLock(this.#ctx, async () => {
            await this.#ctx.inTx(async (txCtx) => await this.#clear(txCtx));
        });
    }

    async list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.#lock.runInLock(this.#ctx, async () => {
            return await this.#ctx.inTx(async (txCtx) => {
                validatePrefix(prefix);
                const values = await this.#scanRows(
                    txCtx,
                    prefix,
                    undefined,
                    MAXIMUM_STORE_SCAN_ITEMS + 1,
                );
                if (values.size > MAXIMUM_STORE_SCAN_ITEMS) {
                    throw new Error("The Murmur store list is too large.");
                }
                return values;
            });
        });
    }

    async scan(
        prefix: string,
        options: StoreScanOptions,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.#lock.runInLock(this.#ctx, async () => {
            return await this.#ctx.inTx(async (txCtx) => {
                validateScan(prefix, options);
                return await this.#scanRows(txCtx, prefix, options.after, options.limit);
            });
        });
    }

    async transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return await this.#lock.runInLock(this.#ctx, async () => {
            return await this.#ctx.inTx(async (txCtx) => {
                const transaction: StoreTransaction = {
                    delete: async (key) => await this.#delete(txCtx, key),
                    get: async (key) => await this.#get(txCtx, key),
                    list: async (prefix) => {
                        validatePrefix(prefix);
                        const values = await this.#scanRows(
                            txCtx,
                            prefix,
                            undefined,
                            MAXIMUM_STORE_SCAN_ITEMS + 1,
                        );
                        if (values.size > MAXIMUM_STORE_SCAN_ITEMS) {
                            throw new Error("The Murmur store list is too large.");
                        }
                        return values;
                    },
                    scan: async (prefix, options) => {
                        validateScan(prefix, options);
                        return await this.#scanRows(txCtx, prefix, options.after, options.limit);
                    },
                    set: async (key, value) => await this.#set(txCtx, key, value),
                };
                return await operation(transaction);
            });
        });
    }

    async #get(ctx: Context, key: string): Promise<Uint8Array | undefined> {
        validateKey(key);
        const rows = await agentDatabaseRows<Record<string, unknown>>(
            ctx.db,
            sql`SELECT value_bytes FROM ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                WHERE environment = ${this.#account.environment}
                  AND user_id = ${this.#account.userId}
                  AND store_key = ${key}`,
        );
        const value = rows[0]?.["value_bytes"];
        return value === undefined ? undefined : storedBytes(value);
    }

    async #set(ctx: Context, key: string, value: Uint8Array): Promise<void> {
        validateKey(key);
        validateValue(value);
        try {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                        (environment, user_id, store_key, value_bytes)
                    VALUES (
                        ${this.#account.environment},
                        ${this.#account.userId},
                        ${key},
                        ${value.slice()}
                    )
                    ON CONFLICT (environment, user_id, store_key)
                    DO UPDATE SET value_bytes = EXCLUDED.value_bytes`,
            );
        } catch {
            throw new Error("The Murmur state could not be stored.");
        }
    }

    async #delete(ctx: Context, key: string): Promise<void> {
        validateKey(key);
        try {
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                    WHERE environment = ${this.#account.environment}
                      AND user_id = ${this.#account.userId}
                      AND store_key = ${key}`,
            );
        } catch {
            throw new Error("The Murmur state could not be removed.");
        }
    }

    async #clear(ctx: Context): Promise<void> {
        try {
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                    WHERE environment = ${this.#account.environment}
                      AND user_id = ${this.#account.userId}`,
            );
        } catch {
            throw new Error("The Murmur state could not be removed.");
        }
    }

    async #scanRows(
        ctx: Context,
        prefix: string,
        after: string | undefined,
        limit: number,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        const rows =
            after === undefined
                ? await agentDatabaseRows<Record<string, unknown>>(
                      ctx.db,
                      sql`SELECT store_key, value_bytes
                          FROM ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                          WHERE environment = ${this.#account.environment}
                            AND user_id = ${this.#account.userId}
                            AND substr(store_key, 1, length(${prefix})) = ${prefix}
                          ORDER BY store_key COLLATE BINARY
                          LIMIT ${limit}`,
                  )
                : await agentDatabaseRows<Record<string, unknown>>(
                      ctx.db,
                      sql`SELECT store_key, value_bytes
                          FROM ${sql.raw(CLOUD_MURMUR_STORE_TABLE)}
                          WHERE environment = ${this.#account.environment}
                            AND user_id = ${this.#account.userId}
                            AND substr(store_key, 1, length(${prefix})) = ${prefix}
                            AND store_key > ${after}
                          ORDER BY store_key COLLATE BINARY
                          LIMIT ${limit}`,
                  );
        const result = new Map<string, Uint8Array>();
        for (const row of rows) {
            const key = row["store_key"];
            if (typeof key !== "string" || !key.startsWith(prefix)) {
                throw new Error("The stored Murmur state is invalid.");
            }
            result.set(key, storedBytes(row["value_bytes"]));
        }
        return result;
    }
}

function validateScan(prefix: string, options: StoreScanOptions): void {
    validatePrefix(prefix);
    if (
        !Number.isSafeInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > MAXIMUM_STORE_SCAN_ITEMS ||
        (options.after !== undefined && !options.after.startsWith(prefix))
    ) {
        throw new Error("Invalid Murmur store scan.");
    }
    if (options.after !== undefined) validateKey(options.after);
}

function validatePrefix(prefix: string): void {
    if (prefix.length > MAXIMUM_KEY_CHARACTERS || prefix.includes("\0")) {
        throw new Error("Invalid Murmur store prefix.");
    }
}

function validateKey(key: string): void {
    if (key.length === 0 || key.length > MAXIMUM_KEY_CHARACTERS || key.includes("\0")) {
        throw new Error("Invalid Murmur store key.");
    }
}

function validateValue(value: Uint8Array): void {
    if (!(value instanceof Uint8Array) || value.byteLength > MAXIMUM_VALUE_BYTES) {
        throw new Error("Invalid Murmur store value.");
    }
}

function storedBytes(value: unknown): Uint8Array {
    const bytes =
        value instanceof Uint8Array
            ? new Uint8Array(value)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value.slice(0))
              : undefined;
    if (bytes === undefined) throw new Error("The stored Murmur state is invalid.");
    validateValue(bytes);
    return bytes;
}
