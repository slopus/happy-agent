import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@steve.kite/stdlib";

import type { DatabaseScope, TX } from "../Transaction.js";
import { inTx } from "../inTx.js";
import {
    getSessionDatabaseOwner,
    type SessionDatabase,
} from "./SessionDatabase.js";

interface TransactionState {
    readonly callbacks: Array<() => void | Promise<void>>;
    readonly rollbackCallbacks: Array<() => void | Promise<void>>;
    readonly ctx: Context;
    readonly database: SessionDatabase;
    readonly tx: TX;
    active: boolean;
}

const transactionStorage = new AsyncLocalStorage<TransactionState>();

export class SessionTransactionPostCommitError extends Error {
    readonly failures: readonly unknown[];

    constructor(failures: readonly unknown[]) {
        const cause =
            failures.length === 1
                ? failures[0]
                : new AggregateError(failures, "Multiple post-commit callbacks failed.");
        super("A post-commit callback failed after the database transaction committed.", { cause });
        this.name = "SessionTransactionPostCommitError";
        this.failures = [...failures];
    }
}

export function isSessionTransactionPostCommitError(
    error: unknown,
): error is SessionTransactionPostCommitError {
    return error instanceof SessionTransactionPostCommitError;
}

export function currentSessionTransaction(database?: SessionDatabase): TX | undefined {
    const state = transactionStorage.getStore();
    const owner = database === undefined ? undefined : getSessionDatabaseOwner(database);
    if (state === undefined || !state.active || (owner !== undefined && state.database !== owner)) {
        return undefined;
    }
    return state.tx;
}

/**
 * Runs a callback now when there is no transaction, or queues it for the
 * enclosing transaction's commit. The returned promise always represents the
 * callback when it runs immediately; callers must await it.
 */
export function deferSessionTransactionCommit(
    callback: () => void | Promise<void>,
    database?: SessionDatabase,
): Promise<void> {
    const state = transactionStorage.getStore();
    const owner = database === undefined ? undefined : getSessionDatabaseOwner(database);
    if (state === undefined || !state.active || (owner !== undefined && state.database !== owner)) {
        return runImmediately(callback, state !== undefined);
    }
    state.callbacks.push(callback);
    return Promise.resolve();
}

/**
 * Registers cleanup that runs only when the enclosing transaction rolls back.
 *
 * Registration is deliberately synchronous so feature-owned filesystem staging can establish its
 * rollback guarantee before returning from a catalog mutation.
 */
export function deferSessionTransactionRollback(
    callback: () => void | Promise<void>,
    database?: SessionDatabase,
): void {
    const state = transactionStorage.getStore();
    const owner = database === undefined ? undefined : getSessionDatabaseOwner(database);
    if (state === undefined || !state.active || (owner !== undefined && state.database !== owner)) {
        throw new Error("A rollback callback requires an active session transaction.");
    }
    state.rollbackCallbacks.push(callback);
}

export async function runSessionTransaction<T>(
    ctx: Context,
    operation: (ctx: Context) => T | Promise<T>,
): Promise<T> {
    const database = getSessionDatabaseOwner(ctx.tx as SessionDatabase) as
        | SessionDatabase
        | undefined;
    if (database === undefined) throw new Error("Context has no session database owner.");
    const existing = transactionStorage.getStore();
    if (existing?.active === true && existing.database === database) {
        return await operation(existing.ctx);
    }

    let callbacks: Array<() => void | Promise<void>> = [];
    let transactionState: TransactionState | undefined;
    let result: T;
    try {
        result = await inTx(ctx, "rig.sql.session.transaction", async (ctx) => {
            const state: TransactionState = {
                active: true,
                callbacks: [],
                rollbackCallbacks: [],
                ctx,
                database,
                tx: ctx.tx as TX,
            };
            transactionState = state;
            callbacks = state.callbacks;
            return await transactionStorage.run(state, () => operation(ctx));
        });
    } catch (error) {
        const rollbackFailures: unknown[] = [];
        for (const callback of [...(transactionState?.rollbackCallbacks ?? [])].reverse()) {
            try {
                await transactionStorage.exit(() => callback());
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
            }
        }
        if (rollbackFailures.length > 0) {
            throw new AggregateError(
                [error, ...rollbackFailures],
                "The session transaction and its rollback cleanup failed.",
            );
        }
        throw error;
    } finally {
        if (transactionState !== undefined) transactionState.active = false;
    }
    const callbackFailures: unknown[] = [];
    for (const callback of callbacks) {
        try {
            await transactionStorage.exit(() => callback());
        } catch (error) {
            callbackFailures.push(error);
        }
    }
    if (callbackFailures.length > 0) {
        throw new SessionTransactionPostCommitError(callbackFailures);
    }
    return result;
}

export function sessionTransactionScope(database: SessionDatabase): DatabaseScope {
    return currentSessionTransaction(database) ?? database;
}

function runImmediately(
    callback: () => void | Promise<void>,
    leaveCurrentContext: boolean,
): Promise<void> {
    const invoke = (): Promise<void> => {
        try {
            return Promise.resolve(callback()).then(() => undefined);
        } catch (error) {
            return Promise.reject(error);
        }
    };
    return leaveCurrentContext ? transactionStorage.exit(invoke) : invoke();
}
