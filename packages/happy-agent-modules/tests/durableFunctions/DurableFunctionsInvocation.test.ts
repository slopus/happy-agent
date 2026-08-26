import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { DurableFunctionsModule } from "../../sources/durableFunctions/DurableFunctionsModule.js";
import {
    deferred,
    durableFunctionsHarness,
    pendingCallCount,
    waitForCondition,
} from "./support/durableFunctionsHarness.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const argumentsSchema = Type.Object({ label: Type.String() }, { additionalProperties: false });
const resultSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });

describe("Durable Functions invocation", () => {
    it("recovers a call committed before the module receives its startup context", async () => {
        const executions: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "record",
            argumentsSchema,
            resultSchema,
            executor: async (_ctx, call) => {
                executions.push(call.arguments.label);
                return { ok: true };
            },
        });
        const database = moduleDatabase(module.migrations, "durable-before-start-context");
        try {
            await database.ready;
            await module.invoke(database.context, {
                function: "record",
                arguments: { label: "waiting" },
            });
            expect(executions).toEqual([]);
            expect(await pendingCallCount(database.context)).toBe(1);

            const hooks = module.beforeStart(database.context);
            await hooks.afterStart?.(database.context, {} as never);
            await waitForCondition(() => executions.length === 1);
            await waitForCondition(async () => (await pendingCallCount(database.context)) === 0);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("executes a call only after its outer transaction commits and never after rollback", async () => {
        const executions: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "record",
            argumentsSchema,
            resultSchema,
            executor: async (_ctx, call) => {
                executions.push(call.arguments.label);
                return { ok: true };
            },
        });
        const harness = await durableFunctionsHarness("durable-invoke-transaction", { module });
        try {
            await harness.database.context.inTx(async (txCtx) => {
                await module.invoke(txCtx, {
                    function: "record",
                    arguments: { label: "committed" },
                });
                expect(executions).toEqual([]);
            });
            await waitForCondition(() => executions.length === 1);
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );

            await expect(
                harness.database.context.inTx(async (txCtx) => {
                    await module.invoke(txCtx, {
                        function: "record",
                        arguments: { label: "rolled back" },
                    });
                    expect(executions).toEqual(["committed"]);
                    throw new Error("roll back the caller");
                }),
            ).rejects.toThrow("roll back the caller");

            expect(executions).toEqual(["committed"]);
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
        } finally {
            harness.close();
        }
    });

    it("holds committed calls until afterStart releases dispatch", async () => {
        const executions: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "record",
            argumentsSchema,
            resultSchema,
            executor: async (_ctx, call) => {
                executions.push(call.arguments.label);
                return { ok: true };
            },
        });
        const harness = await durableFunctionsHarness("durable-after-start-gate", {
            module,
            start: false,
        });
        try {
            await module.invoke(harness.database.context, {
                function: "record",
                arguments: { label: "held" },
            });
            expect(executions).toEqual([]);
            expect(await pendingCallCount(harness.database.context)).toBe(1);

            await harness.start();
            await waitForCondition(() => executions.length === 1);
        } finally {
            harness.close();
        }
    });

    it("does not deadlock executor KV behind a caller transaction that invokes again", async () => {
        const firstStarted = deferred<void>();
        const allowStateWrite = deferred<void>();
        const stateWriteAttempted = deferred<void>();
        const stateWritten = deferred<void>();
        const completed: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "database-order",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                if (call.arguments.label === "first") {
                    firstStarted.resolve();
                    await allowStateWrite.promise;
                    stateWriteAttempted.resolve();
                    await call.kv.write(ctx, "checkpoint", "written");
                    stateWritten.resolve();
                }
                return { ok: true };
            },
            onSuccess: async (_ctx, call) => {
                completed.push(call.arguments.label);
            },
        });
        const harness = await durableFunctionsHarness("durable-database-lock-order", { module });
        try {
            await module.invoke(harness.database.context, {
                function: "database-order",
                arguments: { label: "first" },
            });
            await firstStarted.promise;

            const nested = await harness.database.context.inTx(async (txCtx) => {
                // The read proves this context already owns the Agent Database root FIFO.
                expect(await pendingCallCount(txCtx)).toBe(1);
                allowStateWrite.resolve();
                await stateWriteAttempted.promise;
                // Give the executor one macrotask to queue its root KV write behind this transaction.
                await new Promise<void>((resolve) => setImmediate(resolve));
                return await module.invoke(txCtx, {
                    function: "database-order",
                    arguments: { label: "second" },
                });
            });

            expect(nested.status).toBe("created");
            await stateWritten.promise;
            await vi.waitFor(() => expect(completed).toHaveLength(2));
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
        } finally {
            harness.close();
        }
    });

    it("returns the existing pending call for a duplicate operation ID", async () => {
        const gate = deferred<{ ok: boolean }>();
        let executions = 0;
        const module = new DurableFunctionsModule();
        module.register({
            name: "held",
            argumentsSchema,
            resultSchema,
            executor: async () => {
                executions += 1;
                return await gate.promise;
            },
        });
        const harness = await durableFunctionsHarness("durable-duplicate-operation", { module });
        try {
            const first = await module.invoke(harness.database.context, {
                function: "held",
                operationId: "same-operation",
                arguments: { label: "first" },
            });
            const duplicate = await module.invoke(harness.database.context, {
                function: "held",
                operationId: "same-operation",
                arguments: { label: "different but valid" },
            });

            expect(first.status).toBe("created");
            expect(duplicate).toEqual({ callId: first.callId, status: "duplicate" });
            await waitForCondition(() => executions === 1);
            expect(executions).toBe(1);
            expect(await pendingCallCount(harness.database.context)).toBe(1);

            gate.resolve({ ok: true });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
        } finally {
            harness.close();
        }
    });

    it("rejects unknown functions and arguments outside the registered schema", async () => {
        const module = new DurableFunctionsModule();
        module.register({
            name: "known",
            argumentsSchema,
            resultSchema,
            executor: async () => ({ ok: true }),
        });
        const harness = await durableFunctionsHarness("durable-invalid-invoke", { module });
        try {
            await expect(
                module.invoke(harness.database.context, {
                    function: "missing",
                    arguments: { label: "value" },
                }),
            ).rejects.toThrow("not registered");
            await expect(
                module.invoke(harness.database.context, {
                    function: "known",
                    arguments: { label: 42 },
                }),
            ).rejects.toThrow("invalid");
            await expect(
                module.invoke(harness.database.context, {
                    function: "known",
                    operationId: "",
                    arguments: { label: "value" },
                }),
            ).rejects.toThrow("invalid");
            await expect(
                module.invoke(harness.database.context, {
                    function: "known",
                    arguments: { label: "value" },
                    lockKeys: [""],
                }),
            ).rejects.toThrow("invalid");
            await expect(
                module.invoke(harness.database.context, {
                    function: "known",
                    arguments: { label: "value" },
                    lockKeys: Array.from({ length: 65 }, (_, index) => `lock-${index}`),
                }),
            ).rejects.toThrow("invalid");
            expect(await pendingCallCount(harness.database.context)).toBe(0);
        } finally {
            harness.close();
        }
    });

    it("rejects duplicate registration and closes registration when afterStart begins", async () => {
        const module = new DurableFunctionsModule();
        const definition = {
            name: "once",
            argumentsSchema,
            resultSchema,
            executor: async () => ({ ok: true }),
        };
        module.register(definition);
        expect(() => module.register(definition)).toThrow("already registered");

        const harness = await durableFunctionsHarness("durable-registration-closed", {
            module,
            start: false,
        });
        try {
            const starting = harness.hooks.afterStart?.(harness.database.context, {} as never);
            expect(() =>
                module.register({
                    ...definition,
                    name: "too-late",
                }),
            ).toThrow("closed");
            await starting;
        } finally {
            harness.close();
        }
    });
});
