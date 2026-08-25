import { createId } from "@paralleldrive/cuid2";
import {
    AgentKV,
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import { TypeGuard } from "@sinclair/typebox/type";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    asyncLock,
    detach,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { DurableFunctionPersistence } from "./DurableFunctionPersistence.js";
import {
    durableFunctionCallSchema,
    durableFunctionDefinitionSchema,
    durableFunctionInvokeResultSchema,
    durableFunctionInvokeSchema,
    durableFunctionOperationIdSchema,
    durableFunctionTimestampSchema,
    type DurableFunctionCall,
    type DurableFunctionDefinition,
    type DurableFunctionInvoke,
    type DurableFunctionInvokeResult,
} from "./DurableFunctions.js";
import {
    assertDurableFunctionCall,
    assertDurableFunctionsStore,
    MAX_DURABLE_FUNCTION_RECOVERY_BATCH,
    type DurableFunctionsStore,
} from "./DurableFunctionsStore.js";
import {
    createSqliteDurableFunctionsStorage,
    durableFunctionsMigrations,
} from "./SqliteDurableFunctionsStorage.js";

type AnyDurableFunctionDefinition = DurableFunctionDefinition<TSchema, TSchema>;
type RunningCall = {
    readonly call: DurableFunctionCall;
    readonly controller: AbortController;
    readonly lockKeys: ReadonlySet<string>;
};

/**
 * Durable fire-and-forget procedures that begin only after their creating transaction commits.
 *
 * One pending row is the complete delivery guarantee. It remains while execution is owed, is
 * recovered after a restart, and is deleted in one transaction on success or terminal executor
 * failure. Executors and success handlers must be idempotent because a crash after external work
 * but before that deletion causes the executor to run again after the next start.
 */
export class DurableFunctionsModule implements AgentModule {
    readonly name = "durableFunctions";
    readonly migrations = durableFunctionsMigrations;

    readonly #store: DurableFunctionsStore;
    readonly #definitions = new Map<string, AnyDurableFunctionDefinition>();
    readonly #dispatchLock: AsyncLock = asyncLock({ reentry: "block" });
    readonly #waiting = new Map<string, DurableFunctionCall>();
    readonly #running = new Map<string, RunningCall>();
    readonly #heldLockKeys = new Set<string>();
    readonly #moduleLifetime = new AbortController();

    #registrationsClosed = false;
    #dispatchStarted = false;
    #stopped = false;
    #dispatchCtx: Context | undefined;
    #persistence: DurableFunctionPersistence | undefined;

    constructor() {
        const store = createSqliteDurableFunctionsStorage();
        assertDurableFunctionsStore(store);
        this.#store = store;
    }

    /**
     * Take the database and create the detached lifetime every execution belongs to.
     *
     * Recovery waits for `afterStart`, so no call can execute while the rest of the system is
     * still restoring. Registration remains open throughout every module's `beforeStart`.
     */
    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Durable Functions was started without an agent database.");
        }
        const detached = withAgentDatabase(detach(ctx).named("durable-functions"), database);
        this.#dispatchCtx = withLifetime(detached, this.#moduleLifetime.signal);
        this.#persistence = new DurableFunctionPersistence(database, this.#store);
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        afterStart: async (ctx: Context): Promise<void> => {
            if (this.#dispatchStarted) return;
            // This assignment happens before the first await: once recovery begins, even a caller
            // racing this hook can no longer change what stored calls mean.
            this.#registrationsClosed = true;
            await this.#recoverPending(ctx);
            await this.#startDispatch();
        },
    };

    /** Register one stable procedure before restart recovery begins. */
    register<Arguments extends TSchema, Result extends TSchema>(
        definition: DurableFunctionDefinition<Arguments, Result>,
    ): void {
        if (this.#registrationsClosed) {
            throw new Error("Durable function registration is closed after system startup.");
        }
        if (
            !Value.Check(durableFunctionDefinitionSchema, definition) ||
            !TypeGuard.IsSchema(definition.argumentsSchema) ||
            !TypeGuard.IsSchema(definition.resultSchema)
        ) {
            throw new Error("Durable Functions received an invalid function definition.");
        }
        if (this.#definitions.has(definition.name)) {
            throw new Error(`Durable function "${definition.name}" is already registered.`);
        }
        this.#definitions.set(
            definition.name,
            definition as unknown as AnyDurableFunctionDefinition,
        );
    }

    /**
     * Durably create one call and hand it to the dispatcher only after the outermost commit.
     *
     * An operation ID identifies only a pending call. Reusing one while that row exists returns
     * the existing call ID and writes nothing; after completion or cancellation it may be used
     * again.
     */
    async invoke(ctx: Context, input: DurableFunctionInvoke): Promise<DurableFunctionInvokeResult> {
        if (!Value.Check(durableFunctionInvokeSchema, input)) {
            throw new Error("The durable function invocation is invalid.");
        }
        const definition = this.#definitions.get(input.function);
        if (definition === undefined) {
            throw new Error(`Durable function "${input.function}" is not registered.`);
        }
        if (!Value.Check(definition.argumentsSchema, input.arguments)) {
            throw new Error(`Arguments for durable function "${input.function}" are invalid.`);
        }
        const storedArguments = jsonClone(input.arguments, "call arguments");
        if (!Value.Check(definition.argumentsSchema, storedArguments)) {
            throw new Error(
                `Arguments for durable function "${input.function}" do not preserve their schema in JSON.`,
            );
        }
        const call: DurableFunctionCall = {
            id: createId(),
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            function: input.function,
            arguments: storedArguments,
            lockKeys: [...new Set(input.lockKeys ?? [])],
            createdAt: this.#now(),
        };
        if (!Value.Check(durableFunctionCallSchema, call)) {
            throw new Error("Durable Functions created an invalid pending call.");
        }
        return await ctx.inTx(async (txCtx) => {
            const result = await this.#store.createCall(txCtx, call);
            if (!Value.Check(durableFunctionInvokeResultSchema, result)) {
                throw new Error("Durable Functions storage returned an invalid invoke result.");
            }
            if (result.status === "created") {
                afterCommit(txCtx, async () => {
                    await this.#enqueue(call);
                });
            }
            return result;
        });
    }

    /** Cancel the pending call carrying this operation ID, without invoking any handler. */
    async cancel(ctx: Context, operationId: string): Promise<boolean> {
        if (!Value.Check(durableFunctionOperationIdSchema, operationId)) {
            throw new Error("The durable function operation ID is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            const pending = await this.#store.readCallByOperationId(txCtx, operationId);
            if (pending === undefined) return false;
            assertDurableFunctionCall(pending);
            if (!(await this.#store.deleteCallAndState(txCtx, pending.id))) return false;
            afterCommit(txCtx, async () => {
                await this.#cancelDispatch(pending.id);
            });
            return true;
        });
    }

    /** Stop taking new work and abort every execution this process still holds. */
    stop(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#moduleLifetime.abort();
        this.#waiting.clear();
        for (const running of this.#running.values()) running.controller.abort();
    }

    /** Recover calls in durable FIFO order, discarding registrations that no longer match. */
    async #recoverPending(ctx: Context): Promise<void> {
        let afterCreatedAt: number | undefined;
        let afterId: string | undefined;
        for (;;) {
            const pending = await ctx.inTx(
                async (txCtx) =>
                    await this.#store.listCalls(txCtx, {
                        limit: MAX_DURABLE_FUNCTION_RECOVERY_BATCH,
                        ...(afterCreatedAt === undefined || afterId === undefined
                            ? {}
                            : { afterCreatedAt, afterId }),
                    }),
            );
            for (const call of pending) {
                assertDurableFunctionCall(call);
                const definition = this.#definitions.get(call.function);
                if (
                    definition === undefined ||
                    !Value.Check(definition.argumentsSchema, call.arguments)
                ) {
                    await ctx.inTx(async (txCtx) => {
                        await this.#store.deleteCallAndState(txCtx, call.id);
                    });
                    ctx.log.info(
                        { callId: call.id, function: call.function },
                        "Discarded a pending durable function whose registration no longer matches.",
                    );
                    continue;
                }
                await this.#enqueue(call);
            }
            const last = pending.at(-1);
            if (last === undefined || pending.length < MAX_DURABLE_FUNCTION_RECOVERY_BATCH) return;
            afterCreatedAt = last.createdAt;
            afterId = last.id;
        }
    }

    async #startDispatch(): Promise<void> {
        const starts = await this.#dispatchLock.runInLock(
            this.#requireDispatchContext(),
            async () => {
                if (this.#stopped) return [];
                this.#dispatchStarted = true;
                return this.#takeRunnable();
            },
        );
        this.#launchAll(starts);
    }

    async #enqueue(call: DurableFunctionCall): Promise<void> {
        assertDurableFunctionCall(call);
        const starts = await this.#dispatchLock.runInLock(
            this.#requireDispatchContext(),
            async () => {
                if (this.#stopped || this.#running.has(call.id) || this.#waiting.has(call.id)) {
                    return [];
                }
                this.#waiting.set(call.id, structuredClone(call));
                return this.#dispatchStarted ? this.#takeRunnable() : [];
            },
        );
        this.#launchAll(starts);
    }

    async #cancelDispatch(callId: string): Promise<void> {
        await this.#dispatchLock.runInLock(this.#requireDispatchContext(), async () => {
            this.#waiting.delete(callId);
            this.#running.get(callId)?.controller.abort();
        });
    }

    /**
     * Atomically choose every call that can start now.
     *
     * Keys belonging to an older blocked call reserve that call's place without being acquired.
     * A younger overlapping call therefore cannot leapfrog it, while a disjoint call can still
     * run. Actual keys move into `#heldLockKeys` only when the complete set is free.
     */
    #takeRunnable(): RunningCall[] {
        const starts: RunningCall[] = [];
        const blockedKeys = new Set<string>();
        const waiting = [...this.#waiting.values()].sort(compareCalls);
        for (const call of waiting) {
            const lockKeys = new Set(call.lockKeys);
            const blocked =
                intersects(lockKeys, this.#heldLockKeys) || intersects(lockKeys, blockedKeys);
            if (blocked) {
                for (const key of lockKeys) blockedKeys.add(key);
                continue;
            }
            this.#waiting.delete(call.id);
            for (const key of lockKeys) this.#heldLockKeys.add(key);
            const running: RunningCall = {
                call,
                controller: new AbortController(),
                lockKeys,
            };
            this.#running.set(call.id, running);
            starts.push(running);
        }
        return starts;
    }

    #launchAll(starts: readonly RunningCall[]): void {
        for (const running of starts) {
            // Dispatch on the next turn so execution cannot inherit the temporary database owner
            // of an after-commit callback. That owner retains the root FIFO until publication
            // finishes; starting inside it could bypass work already queued behind the commit.
            setImmediate(() => {
                void this.#run(running);
            });
        }
    }

    async #run(running: RunningCall): Promise<void> {
        try {
            await this.#execute(running);
        } catch (error: unknown) {
            this.#requireDispatchContext().log.error(
                { error, callId: running.call.id, function: running.call.function },
                "A durable function dispatcher failed unexpectedly.",
            );
        } finally {
            running.controller.abort();
            await this.#executionFinished(running.call.id);
        }
    }

    async #execute(running: RunningCall): Promise<void> {
        if (this.#stopped || running.controller.signal.aborted) return;
        const definition = this.#definitions.get(running.call.function);
        if (definition === undefined) {
            throw new Error(`Running durable function "${running.call.function}" disappeared.`);
        }
        const ctx = withLifetime(this.#requireDispatchContext(), running.controller.signal);
        const kv = new AgentKV(this.#requirePersistence(), callStatePrefix(running.call.id)).until(
            ctx.lifetime ?? running.controller.signal,
        );
        let result: unknown;
        try {
            result = await definition.executor(ctx, {
                callId: running.call.id,
                operationId: running.call.operationId,
                arguments: running.call.arguments,
                kv,
            });
            if (!Value.Check(definition.resultSchema, result)) {
                throw new Error(
                    `Durable function "${running.call.function}" returned an invalid result.`,
                );
            }
        } catch (error: unknown) {
            // Shutdown keeps every owed row for the next process. Cancellation already deleted its
            // row before firing this signal, so it likewise has nothing left to settle.
            if (this.#stopped || ctx.lifetime?.aborted === true) return;
            await this.#settleFailure(ctx, running.call, error);
            return;
        }

        if (this.#stopped || ctx.lifetime?.aborted === true) return;

        try {
            await ctx.inTx(async (txCtx) => {
                const pending = await this.#store.readCall(txCtx, running.call.id);
                if (pending === undefined) return;
                assertDurableFunctionCall(pending);
                if (pending.function !== running.call.function) {
                    throw new Error(
                        "A pending durable call changed function while it was running.",
                    );
                }
                if (!(await this.#store.deleteCallAndState(txCtx, pending.id))) return;
                await definition.onSuccess?.(txCtx, {
                    callId: pending.id,
                    operationId: pending.operationId,
                    arguments: pending.arguments,
                    result,
                });
            });
        } catch (error: unknown) {
            // The deletion and handler share this transaction. In particular, a handler failure
            // rolls the deletion back and leaves the call and its KV state for the next restart.
            ctx.log.error(
                { error, callId: running.call.id, function: running.call.function },
                "A durable function succeeded, but its completion transaction failed.",
            );
        }
    }

    async #settleFailure(ctx: Context, call: DurableFunctionCall, failure: unknown): Promise<void> {
        try {
            const deleted = await ctx.inTx(
                async (txCtx) => await this.#store.deleteCallAndState(txCtx, call.id),
            );
            if (!deleted) return;
            ctx.log.error(
                { error: failure, callId: call.id, function: call.function },
                "A durable function failed and was removed without retry.",
            );
        } catch (error: unknown) {
            ctx.log.error(
                { error, failure, callId: call.id, function: call.function },
                "A failed durable function could not be removed.",
            );
        }
    }

    async #executionFinished(callId: string): Promise<void> {
        const starts = await this.#dispatchLock.runInLock(
            this.#requireDispatchContext(),
            async () => {
                const running = this.#running.get(callId);
                if (running === undefined) return [];
                this.#running.delete(callId);
                for (const key of running.lockKeys) this.#heldLockKeys.delete(key);
                return this.#stopped ? [] : this.#takeRunnable();
            },
        );
        this.#launchAll(starts);
    }

    #now(): number {
        const now = Date.now();
        if (!Value.Check(durableFunctionTimestampSchema, now)) {
            throw new Error("The clock returned a time Durable Functions cannot represent.");
        }
        return now;
    }

    #requireDispatchContext(): Context {
        if (this.#dispatchCtx === undefined) {
            throw new Error("Durable Functions has not been started by an agent system yet.");
        }
        return this.#dispatchCtx;
    }

    #requirePersistence(): DurableFunctionPersistence {
        if (this.#persistence === undefined) {
            throw new Error("Durable Functions has not been started by an agent system yet.");
        }
        return this.#persistence;
    }
}

function compareCalls(left: DurableFunctionCall, right: DurableFunctionCall): number {
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    for (const key of left) if (right.has(key)) return true;
    return false;
}

function jsonClone(value: unknown, label: string): unknown {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("undefined");
        return JSON.parse(encoded) as unknown;
    } catch {
        throw new Error(`Durable Functions ${label} is not JSON-serializable.`);
    }
}

function callStatePrefix(callId: string): string {
    return `call.${callId}.`;
}
