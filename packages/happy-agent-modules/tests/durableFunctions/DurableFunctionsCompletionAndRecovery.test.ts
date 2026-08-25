import { Type } from "@sinclair/typebox";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { DurableFunctionsModule } from "../../sources/durableFunctions/DurableFunctionsModule.js";
import {
    deferred,
    durableFunctionsHarness,
    durableStateCount,
    pendingCallCount,
    waitForCondition,
} from "./support/durableFunctionsHarness.js";

const argumentsSchema = Type.Object({ label: Type.String() }, { additionalProperties: false });
const resultSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });

describe("Durable Functions completion and recovery", () => {
    it("deletes the call and KV before onSuccess in the same committing transaction", async () => {
        let handlerSawDeletedState = false;
        const module = new DurableFunctionsModule();
        module.register({
            name: "success",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                await call.kv.write(ctx, "progress", { done: true });
                return { value: "complete" };
            },
            onSuccess: async (ctx, call) => {
                const calls = await pendingCallCount(ctx);
                const state = await durableStateCount(ctx);
                handlerSawDeletedState = calls === 0 && state === 0;
                await agentDatabaseRun(
                    ctx.db,
                    sql`INSERT INTO durable_function_test_success (value)
                        VALUES (${call.result.value})`,
                );
            },
        });
        const harness = await durableFunctionsHarness("durable-success-transaction", {
            module,
            start: false,
        });
        try {
            await agentDatabaseRun(
                harness.database.database,
                sql`CREATE TABLE durable_function_test_success (value TEXT NOT NULL)`,
            );
            await harness.start();
            await module.invoke(harness.database.context, {
                function: "success",
                arguments: { label: "one" },
            });
            await waitForCondition(async () => {
                const rows = await agentDatabaseRows<{ readonly value: string }>(
                    harness.database.database,
                    sql`SELECT value FROM durable_function_test_success`,
                );
                return rows.length === 1;
            });

            expect(handlerSawDeletedState).toBe(true);
            expect(await pendingCallCount(harness.database.context)).toBe(0);
            expect(await durableStateCount(harness.database.context)).toBe(0);
        } finally {
            harness.close();
        }
    });

    it("rolls deletion and handler writes back when onSuccess throws", async () => {
        let executions = 0;
        const module = new DurableFunctionsModule();
        module.register({
            name: "handler-fails",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                executions += 1;
                await call.kv.write(ctx, "progress", executions);
                return { value: "complete" };
            },
            onSuccess: async (ctx) => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`INSERT INTO durable_function_test_success (value) VALUES ('rolled-back')`,
                );
                throw new Error("handler failed");
            },
        });
        const harness = await durableFunctionsHarness("durable-handler-rollback", {
            module,
            start: false,
        });
        try {
            await agentDatabaseRun(
                harness.database.database,
                sql`CREATE TABLE durable_function_test_success (value TEXT NOT NULL)`,
            );
            await harness.start();
            await module.invoke(harness.database.context, {
                function: "handler-fails",
                arguments: { label: "one" },
            });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 1,
            );
            await waitForCondition(
                async () => (await durableStateCount(harness.database.context)) === 1,
            );

            const handlerRows = await agentDatabaseRows(
                harness.database.database,
                sql`SELECT value FROM durable_function_test_success`,
            );
            expect(handlerRows).toEqual([]);
            expect(executions).toBe(1);
        } finally {
            harness.close();
        }
    });

    it("deletes call and KV after an executor throw or invalid result without retry", async () => {
        let thrownExecutions = 0;
        let invalidExecutions = 0;
        const module = new DurableFunctionsModule();
        module.register({
            name: "throws",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                thrownExecutions += 1;
                await call.kv.write(ctx, "progress", true);
                throw new Error("terminal failure");
            },
        });
        module.register({
            name: "invalid-result",
            argumentsSchema,
            resultSchema,
            executor: async () => {
                invalidExecutions += 1;
                return { value: 42 } as never;
            },
        });
        const harness = await durableFunctionsHarness("durable-terminal-failure", { module });
        try {
            await module.invoke(harness.database.context, {
                function: "throws",
                arguments: { label: "throw" },
            });
            await module.invoke(harness.database.context, {
                function: "invalid-result",
                arguments: { label: "invalid" },
            });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );

            expect(await durableStateCount(harness.database.context)).toBe(0);
            expect(thrownExecutions).toBe(1);
            expect(invalidExecutions).toBe(1);
        } finally {
            harness.close();
        }
    });

    it("re-runs a pending call after restart with executor KV state from the crashed run", async () => {
        const firstExecutionStarted = deferred<void>();
        let firstExecutions = 0;
        const firstModule = new DurableFunctionsModule();
        firstModule.register({
            name: "recover",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                firstExecutions += 1;
                await call.kv.write(ctx, "checkpoint", { step: 3 });
                firstExecutionStarted.resolve();
                return await new Promise<never>(() => {});
            },
        });
        const first = await durableFunctionsHarness("durable-crash-recovery", {
            module: firstModule,
        });
        try {
            await firstModule.invoke(first.database.context, {
                function: "recover",
                operationId: "recover-operation",
                arguments: { label: "recover" },
            });
            await firstExecutionStarted.promise;
            expect(await pendingCallCount(first.database.context)).toBe(1);
            expect(await durableStateCount(first.database.context)).toBe(1);
            firstModule.stop();

            let recoveredState: unknown;
            let secondExecutions = 0;
            const secondModule = new DurableFunctionsModule();
            secondModule.register({
                name: "recover",
                argumentsSchema,
                resultSchema,
                executor: async (ctx, call) => {
                    secondExecutions += 1;
                    recoveredState = await call.kv.read(ctx, "checkpoint");
                    return { value: "recovered" };
                },
            });
            const second = await durableFunctionsHarness("durable-crash-recovery-second", {
                database: first.database,
                module: secondModule,
            });
            try {
                await waitForCondition(
                    async () => (await pendingCallCount(first.database.context)) === 0,
                );
                expect(firstExecutions).toBe(1);
                expect(secondExecutions).toBe(1);
                expect(recoveredState).toEqual({ step: 3 });
                expect(await durableStateCount(first.database.context)).toBe(0);
            } finally {
                second.module.stop();
            }
        } finally {
            first.close();
        }
    });

    it("deletes recovered calls whose function is absent or whose arguments no longer match", async () => {
        const oldModule = new DurableFunctionsModule();
        oldModule.register({
            name: "changed",
            argumentsSchema,
            resultSchema,
            executor: async () => ({ value: "old" }),
        });
        oldModule.register({
            name: "removed",
            argumentsSchema,
            resultSchema,
            executor: async () => ({ value: "old" }),
        });
        const first = await durableFunctionsHarness("durable-stale-recovery", {
            module: oldModule,
            start: false,
        });
        try {
            await oldModule.invoke(first.database.context, {
                function: "changed",
                arguments: { label: "old-shape" },
            });
            await oldModule.invoke(first.database.context, {
                function: "removed",
                arguments: { label: "gone" },
            });
            oldModule.stop();
            expect(await pendingCallCount(first.database.context)).toBe(2);

            let executions = 0;
            const recoveredModule = new DurableFunctionsModule();
            recoveredModule.register({
                name: "changed",
                argumentsSchema: Type.Object(
                    { count: Type.Number() },
                    { additionalProperties: false },
                ),
                resultSchema,
                executor: async () => {
                    executions += 1;
                    return { value: "new" };
                },
            });
            const recovered = await durableFunctionsHarness("durable-stale-recovery-second", {
                database: first.database,
                module: recoveredModule,
            });
            try {
                expect(await pendingCallCount(first.database.context)).toBe(0);
                expect(await durableStateCount(first.database.context)).toBe(0);
                expect(executions).toBe(0);
            } finally {
                recovered.module.stop();
            }
        } finally {
            first.close();
        }
    });
});
