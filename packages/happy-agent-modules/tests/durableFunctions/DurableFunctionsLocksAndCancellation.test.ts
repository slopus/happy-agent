import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { DurableFunctionsModule } from "../../sources/durableFunctions/DurableFunctionsModule.js";
import {
    deferred,
    durableFunctionsHarness,
    durableStateCount,
    pendingCallCount,
    waitForCondition,
} from "./support/durableFunctionsHarness.js";

const argumentsSchema = Type.Object({ label: Type.String() }, { additionalProperties: false });
const resultSchema = Type.Object({ label: Type.String() }, { additionalProperties: false });

describe("Durable Functions locks and cancellation", () => {
    it("acquires every lock together, preserves overlapping FIFO, and runs disjoint calls in parallel", async () => {
        vi.useFakeTimers({ now: 1_000 });
        const started: string[] = [];
        const gates = new Map<string, ReturnType<typeof deferred<{ label: string }>>>();
        const module = new DurableFunctionsModule();
        module.register({
            name: "locked",
            argumentsSchema,
            resultSchema,
            executor: async (_ctx, call) => {
                started.push(call.arguments.label);
                const gate = deferred<{ label: string }>();
                gates.set(call.arguments.label, gate);
                return await gate.promise;
            },
        });
        const harness = await durableFunctionsHarness("durable-locks", { module });
        try {
            await module.invoke(harness.database.context, {
                function: "locked",
                arguments: { label: "holds-a" },
                lockKeys: ["a"],
            });
            vi.setSystemTime(1_001);
            await module.invoke(harness.database.context, {
                function: "locked",
                arguments: { label: "oldest-a-b" },
                lockKeys: ["a", "b"],
            });
            vi.setSystemTime(1_002);
            await module.invoke(harness.database.context, {
                function: "locked",
                arguments: { label: "younger-b" },
                lockKeys: ["b"],
            });
            vi.setSystemTime(1_003);
            await module.invoke(harness.database.context, {
                function: "locked",
                arguments: { label: "disjoint-c" },
                lockKeys: ["c"],
            });
            vi.setSystemTime(1_004);
            await module.invoke(harness.database.context, {
                function: "locked",
                arguments: { label: "unlocked" },
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(started).toEqual(["holds-a", "disjoint-c", "unlocked"]);
            gates.get("disjoint-c")?.resolve({ label: "disjoint-c" });
            gates.get("unlocked")?.resolve({ label: "unlocked" });
            await Promise.resolve();
            expect(started).toEqual(["holds-a", "disjoint-c", "unlocked"]);

            gates.get("holds-a")?.resolve({ label: "holds-a" });
            await waitForCondition(() => started.includes("oldest-a-b"));
            expect(started).not.toContain("younger-b");

            gates.get("oldest-a-b")?.resolve({ label: "oldest-a-b" });
            await waitForCondition(() => started.includes("younger-b"));
            gates.get("younger-b")?.resolve({ label: "younger-b" });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
        } finally {
            harness.close();
            vi.useRealTimers();
        }
    });

    it("cancels a call waiting on locks and never starts it", async () => {
        const gate = deferred<{ label: string }>();
        const started: string[] = [];
        const module = new DurableFunctionsModule();
        module.register({
            name: "locked",
            argumentsSchema,
            resultSchema,
            executor: async (_ctx, call) => {
                started.push(call.arguments.label);
                if (call.arguments.label === "holder") return await gate.promise;
                return { label: call.arguments.label };
            },
        });
        const harness = await durableFunctionsHarness("durable-cancel-pending", { module });
        try {
            await module.invoke(harness.database.context, {
                function: "locked",
                operationId: "holder-operation",
                arguments: { label: "holder" },
                lockKeys: ["same"],
            });
            await module.invoke(harness.database.context, {
                function: "locked",
                operationId: "cancel-pending",
                arguments: { label: "pending" },
                lockKeys: ["same"],
            });
            await waitForCondition(() => started.length === 1);
            expect(started).toEqual(["holder"]);

            await expect(module.cancel(harness.database.context, "cancel-pending")).resolves.toBe(
                true,
            );
            await expect(module.cancel(harness.database.context, "cancel-pending")).resolves.toBe(
                false,
            );
            gate.resolve({ label: "holder" });
            await waitForCondition(
                async () => (await pendingCallCount(harness.database.context)) === 0,
            );
            expect(started).toEqual(["holder"]);
        } finally {
            harness.close();
        }
    });

    it("deletes and aborts a running call, whose later failure writes nothing", async () => {
        let aborted = false;
        let successHandled = false;
        let retainedWriteRejected = false;
        const module = new DurableFunctionsModule();
        module.register({
            name: "running",
            argumentsSchema,
            resultSchema,
            executor: async (ctx, call) => {
                await call.kv.write(ctx, "started", true);
                await new Promise<void>((resolve) => {
                    ctx.lifetime?.addEventListener("abort", () => resolve(), { once: true });
                });
                aborted = true;
                try {
                    await call.kv.write(ctx, "after-cancel", true);
                } catch {
                    retainedWriteRejected = true;
                }
                throw new Error("cancelled execution ended");
            },
            onSuccess: async () => {
                successHandled = true;
            },
        });
        const harness = await durableFunctionsHarness("durable-cancel-running", { module });
        try {
            await module.invoke(harness.database.context, {
                function: "running",
                operationId: "cancel-running",
                arguments: { label: "running" },
            });
            await waitForCondition(
                async () => (await durableStateCount(harness.database.context)) === 1,
            );

            await expect(module.cancel(harness.database.context, "cancel-running")).resolves.toBe(
                true,
            );
            await waitForCondition(() => aborted && retainedWriteRejected);
            expect(successHandled).toBe(false);
            expect(await pendingCallCount(harness.database.context)).toBe(0);
            expect(await durableStateCount(harness.database.context)).toBe(0);
        } finally {
            harness.close();
        }
    });
});
