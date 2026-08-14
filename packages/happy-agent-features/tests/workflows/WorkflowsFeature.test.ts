import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH,
    workflowMutationResultSchema,
    workflowOperationFingerprintSchema,
    workflowOperationReceiptSchema,
    workflowRunSchema,
    type WorkflowStore,
} from "../../sources/workflows/index.js";
import {
    WorkflowsFeature as RootWorkflowsFeature,
    listWorkflowsTool as rootListWorkflowsTool,
    resumeWorkflowTool as rootResumeWorkflowTool,
    runWorkflowTool as rootRunWorkflowTool,
    stopWorkflowTool as rootStopWorkflowTool,
    waitWorkflowTool as rootWaitWorkflowTool,
    workflowFeatureOptionsSchema as rootWorkflowFeatureOptionsSchema,
    workflowLogsTool as rootWorkflowLogsTool,
    workflowMutationResultSchema as rootWorkflowMutationResultSchema,
    workflowOperationFingerprintSchema as rootWorkflowOperationFingerprintSchema,
    workflowOperationReceiptSchema as rootWorkflowOperationReceiptSchema,
    workflowRunSchema as rootWorkflowRunSchema,
    workflowStatusTool as rootWorkflowStatusTool,
    workflowStoreSchema as rootWorkflowStoreSchema,
    MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH as rootMaxWorkflowOperationFingerprintLength,
    type WorkflowOperationFingerprint as RootWorkflowOperationFingerprint,
    type WorkflowOperationReceipt as RootWorkflowOperationReceipt,
    type WorkflowStore as RootWorkflowStore,
} from "../../sources/index.js";
import {
    WorkflowsFeature,
    workflowFeatureOptionsSchema,
} from "../../sources/workflows/WorkflowsFeature.js";
import type {
    WorkflowLaunchInput,
    WorkflowLogPage,
    WorkflowMutationInput,
    WorkflowMutationResult,
    WorkflowPage,
    WorkflowPageQuery,
    WorkflowRun,
} from "../../sources/workflows/Workflow.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

function ctx(): Context {
    return createRootContext().named("workflow-test");
}

const OWNER = "agent-1";

function run(
    id: string,
    status: WorkflowRun["status"] = "queued",
    overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
    return {
        id,
        agentId: "agent-1",
        workflow: "demo",
        status,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

function storeFixture() {
    const runs = new Map<string, WorkflowRun>();
    const mutationResults = new Map<string, WorkflowRun>();
    const mutationInputs = new Map<
        string,
        { readonly operation: "cancel" | "resume"; readonly id: string }
    >();
    const mutationCalls: Array<{
        readonly operation: "cancel" | "resume";
        readonly operationId: string;
        readonly id: string;
    }> = [];
    const callbacks: Array<(post: Context) => void | Promise<void>> = [];
    const events: unknown[] = [];
    let mutationVersion = 1;

    const receiptKey = (agentId: string, operationId: string): string =>
        `${agentId}:${operationId}`;

    const mutate = async (
        agentId: string,
        operation: "cancel" | "resume",
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> => {
        const operationId = input.operationId;
        if (operationId === undefined) throw new Error("operation ID required");
        mutationCalls.push({ operation, operationId, id: input.id });
        const key = receiptKey(agentId, operationId);
        const previousInput = mutationInputs.get(key);
        const replay = mutationResults.get(key);
        if (previousInput !== undefined || replay !== undefined) {
            if (
                previousInput === undefined ||
                replay === undefined ||
                previousInput.operation !== operation ||
                previousInput.id !== input.id
            ) {
                throw new Error(
                    `Workflow operation "${operationId}" was reused with different target/input.`,
                );
            }
            return { agentId, operationId, run: replay, changed: false };
        }
        const current = runs.get(input.id);
        if (current === undefined || current.agentId !== agentId) throw new Error("missing");
        const next = {
            ...current,
            status: operation === "cancel" ? ("cancelled" as const) : ("running" as const),
            updatedAt: ++mutationVersion,
        };
        runs.set(input.id, next);
        mutationResults.set(key, next);
        mutationInputs.set(key, { operation, id: input.id });
        return { agentId, operationId, run: next, changed: true };
    };

    const store: WorkflowStore = {
        transaction: async (_ctx, _agentId, work) => {
            const before = new Map(runs);
            const beforeMutations = new Map(mutationResults);
            const beforeMutationInputs = new Map(mutationInputs);
            const beforeMutationVersion = mutationVersion;
            const callbackCount = callbacks.length;
            try {
                return await work(ctx());
            } catch (error) {
                runs.clear();
                for (const [id, value] of before) runs.set(id, value);
                mutationResults.clear();
                for (const [id, value] of beforeMutations) mutationResults.set(id, value);
                mutationInputs.clear();
                for (const [id, value] of beforeMutationInputs) {
                    mutationInputs.set(id, value);
                }
                mutationVersion = beforeMutationVersion;
                callbacks.splice(callbackCount);
                throw error;
            }
        },
        afterCommit: (_ctx, callback) => {
            callbacks.push(callback);
        },
        launch: async (_ctx, agentId, input: WorkflowLaunchInput) => {
            const created = run(input.operationId ?? "generated", "queued", { agentId });
            runs.set(created.id, created);
            return created;
        },
        get: async (_ctx, agentId, id) => {
            const value = runs.get(id);
            return value?.agentId === agentId ? value : undefined;
        },
        list: async (_ctx, agentId, query: WorkflowPageQuery): Promise<WorkflowPage> => {
            const ownedRuns = [...runs.values()].filter((value) => value.agentId === agentId);
            const cursor = query.cursor ?? 0;
            const limit = query.limit ?? 50;
            return {
                agentId,
                runs: ownedRuns.slice(cursor, cursor + limit),
                ...(query.cursor === undefined || cursor + limit < ownedRuns.length
                    ? { nextCursor: cursor + limit }
                    : {}),
            };
        },
        cancel: async (_ctx, agentId, input) => await mutate(agentId, "cancel", input),
        resume: async (_ctx, agentId, input) => await mutate(agentId, "resume", input),
        wait: async (_ctx, agentId, id) =>
            runs.get(id)?.agentId === agentId ? runs.get(id)! : run(id, "unavailable", { agentId }),
        logs: async (_ctx, agentId, query): Promise<WorkflowLogPage> => ({
            agentId,
            id: query.id,
            lines: ["hello"],
        }),
    };
    return { store, runs, mutationResults, mutationCalls, callbacks, events };
}

describe("WorkflowsFeature", () => {
    it("exports the complete workflow runtime and tool surface from the package root", () => {
        expect(RootWorkflowsFeature).toBe(WorkflowsFeature);
        expect(rootWorkflowFeatureOptionsSchema).toBe(workflowFeatureOptionsSchema);
        expect(rootWorkflowRunSchema).toBe(workflowRunSchema);
        expect(rootWorkflowMutationResultSchema).toBe(workflowMutationResultSchema);
        expect(rootMaxWorkflowOperationFingerprintLength).toBe(
            MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH,
        );
        expect(rootWorkflowOperationFingerprintSchema).toBe(workflowOperationFingerprintSchema);
        expect(rootWorkflowOperationReceiptSchema).toBe(workflowOperationReceiptSchema);
        const operationFingerprint: RootWorkflowOperationFingerprint = "fingerprint";
        const operationReceipt: RootWorkflowOperationReceipt = {
            operationId: "run-1",
            fingerprint: operationFingerprint,
        };
        expect(operationReceipt).toEqual({
            operationId: "run-1",
            fingerprint: "fingerprint",
        });
        expect(typeof rootWorkflowStoreSchema).toBe("object");
        const fixture = storeFixture();
        const rootStore: RootWorkflowStore = fixture.store;
        expect(rootStore).toBe(fixture.store);
        expect(typeof rootRunWorkflowTool).toBe("function");
        expect(typeof rootListWorkflowsTool).toBe("function");
        expect(typeof rootStopWorkflowTool).toBe("function");
        expect(typeof rootResumeWorkflowTool).toBe("function");
        expect(typeof rootWaitWorkflowTool).toBe("function");
        expect(typeof rootWorkflowLogsTool).toBe("function");
        expect(typeof rootWorkflowStatusTool).toBe("function");
    });

    it("scopes reads and mutations to an agent and rejects foreign store results", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });

        expect(await feature.get(ctx(), "agent-2", "run-1")).toBeUndefined();
        expect(await feature.listPage(ctx(), "agent-2", { cursor: 0 })).toEqual({
            agentId: "agent-2",
            runs: [],
        });
        await expect(
            feature.cancel(ctx(), "agent-2", { id: "run-1", operationId: "agent-2-cancel" }),
        ).rejects.toThrow("missing");
        await expect(feature.wait(ctx(), "agent-2", "run-1")).resolves.toMatchObject({
            agentId: "agent-2",
            status: "unavailable",
        });
        await expect(feature.logs(ctx(), "agent-2", { id: "run-1" })).resolves.toMatchObject({
            agentId: "agent-2",
            id: "run-1",
        });

        const foreignRun = run("run-1", "cancelled", { agentId: OWNER });
        const foreignFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                get: async () => foreignRun,
                list: async () => ({ agentId: OWNER, runs: [foreignRun] }),
                wait: async () => foreignRun,
                logs: async () => ({ agentId: OWNER, id: foreignRun.id, lines: ["foreign"] }),
            },
        });
        await expect(foreignFeature.get(ctx(), "agent-2", "run-1")).rejects.toThrow(
            "another agent",
        );
        await expect(foreignFeature.listPage(ctx(), "agent-2")).rejects.toThrow("another agent");
        await expect(foreignFeature.wait(ctx(), "agent-2", "run-1")).rejects.toThrow(
            "another agent",
        );
        await expect(foreignFeature.logs(ctx(), "agent-2", { id: "run-1" })).rejects.toThrow(
            "outside the requested bound",
        );

        const foreignMutationFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                get: async () => undefined,
                cancel: async (_ctx, _agentId, input) => ({
                    agentId: OWNER,
                    operationId: input.operationId ?? "agent-2-cancel",
                    run: foreignRun,
                    changed: false,
                }),
            },
        });
        await expect(
            foreignMutationFeature.cancel(ctx(), "agent-2", {
                id: "run-1",
                operationId: "agent-2-cancel",
            }),
        ).rejects.toThrow("another agent");
    });

    it("launches, validates identity, and publishes only after commit", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    fixture.events.push(event);
                },
                onEvent: async (_ctx, event) => {
                    fixture.events.push(event);
                },
            },
        });
        const result = await feature.launch(ctx(), OWNER, { workflow: "demo" });
        expect(result.id).toBe("run-1");
        expect(fixture.events).toHaveLength(1);
        expect(fixture.callbacks).toHaveLength(1);
        expect(Object.isFrozen(fixture.events[0])).toBe(true);
        await fixture.callbacks[0]!(ctx());
        expect(fixture.events).toHaveLength(2);
        expect(fixture.events[0]).toBe(fixture.events[1]);
        expect(Object.isFrozen((fixture.events[0] as { run: WorkflowRun }).run)).toBe(true);
    });

    it("reuses operation IDs and rejects mismatched durable retries", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const first = await feature.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-1",
        });
        expect(
            await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" }),
        ).toEqual(first);
        await expect(
            feature.launch(ctx(), OWNER, { workflow: "other", operationId: "run-1" }),
        ).rejects.toThrow("different input");
    });

    it("normalizes launch input and validates the new run identity", async () => {
        const fixture = storeFixture();
        let launchInput: WorkflowLaunchInput | undefined;
        const store: WorkflowStore = {
            ...fixture.store,
            launch: async (_ctx, _agentId, input) => {
                launchInput = input;
                const created = run(input.operationId ?? "generated", "queued", {
                    workflow: input.workflow,
                    ...(input.input === undefined ? {} : { input: input.input }),
                });
                fixture.runs.set(created.id, created);
                return created;
            },
        };
        const feature = new WorkflowsFeature({
            store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const first = await feature.launch(ctx(), OWNER, {
            workflow: "demo",
            input: "one\r\ntwo",
            operationId: "run-1",
        });
        expect(launchInput?.input).toBe("one\ntwo");
        expect(first.input).toBe("one\ntwo");
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "different",
                operationId: "run-1",
            }),
        ).rejects.toThrow("different input");
        expect(
            await feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "one\ntwo",
                operationId: "run-1",
            }),
        ).toEqual(first);
    });

    it("rejects malformed store contracts, transaction results, and asynchronous commit registration", async () => {
        const fixture = storeFixture();
        expect(
            Value.Check(workflowFeatureOptionsSchema, {
                store: { ...fixture.store, unexpected: true },
            }),
        ).toBe(false);
        expect(
            () =>
                new WorkflowsFeature({
                    store: { ...fixture.store, unexpected: true } as never,
                }),
        ).toThrow("options");

        const malformedTransaction: WorkflowStore = {
            ...fixture.store,
            transaction: async () => undefined as never,
        };
        const malformedFeature = new WorkflowsFeature({ store: malformedTransaction });
        await expect(
            malformedFeature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" }),
        ).rejects.toThrow("transaction returned an invalid change");

        const asynchronousCommitStore: WorkflowStore = {
            ...fixture.store,
            afterCommit: (() => Promise.resolve()) as unknown as WorkflowStore["afterCommit"],
        };
        const asynchronousCommitFeature = new WorkflowsFeature({
            store: asynchronousCommitStore,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await expect(
            asynchronousCommitFeature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "run-1",
            }),
        ).rejects.toThrow("register synchronously");
        expect(fixture.runs).toHaveLength(0);
    });

    it("revalidates substituted transaction results for launch and mutation identity", async () => {
        const launchFixture = storeFixture();
        const launchFeature = new WorkflowsFeature({
            store: {
                ...launchFixture.store,
                launch: async (_ctx, _agentId, input) => {
                    const created = run(input.operationId ?? "generated", "queued", {
                        workflow: input.workflow,
                        ...(input.input === undefined ? {} : { input: input.input }),
                    });
                    launchFixture.runs.set(created.id, created);
                    return created;
                },
                transaction: async (_ctx, _agentId, work) => {
                    await work(ctx());
                    return {
                        agentId: OWNER,
                        operationId: "run-1",
                        run: run("run-1", "queued", {
                            workflow: "different",
                            input: "different",
                        }),
                        changed: true,
                    };
                },
            },
        });
        await expect(
            launchFeature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "one\r\ntwo",
                operationId: "run-1",
            }),
        ).rejects.toThrow("substituted run");

        const mutationFixture = storeFixture();
        await mutationFixture.store.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-1",
        });
        const mutationFeature = new WorkflowsFeature({
            store: {
                ...mutationFixture.store,
                transaction: async (_ctx, _agentId, work) => {
                    await work(ctx());
                    return {
                        agentId: OWNER,
                        operationId: "wrong-operation",
                        run: run("run-1", "cancelled"),
                        changed: true,
                    };
                },
            },
        });
        await expect(
            mutationFeature.cancel(ctx(), OWNER, {
                id: "run-1",
                operationId: "cancel-operation",
            }),
        ).rejects.toThrow("wrong operation ID");
    });

    it("rejects CRLF substitutions after the transaction callback", async () => {
        const launchFixture = storeFixture();
        const launchFeature = new WorkflowsFeature({
            store: {
                ...launchFixture.store,
                launch: async (_ctx, agentId, input) => {
                    const created = run(input.operationId ?? "generated", "queued", {
                        agentId,
                        workflow: input.workflow,
                        ...(input.input === undefined ? {} : { input: input.input }),
                    });
                    launchFixture.runs.set(created.id, created);
                    return created;
                },
                transaction: async (_ctx, _agentId, work) => {
                    const callbackChange = await work(ctx());
                    return {
                        ...callbackChange,
                        run: { ...callbackChange.run, input: "one\r\ntwo" },
                    };
                },
            },
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await expect(
            launchFeature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "one\r\ntwo",
                operationId: "run-1",
            }),
        ).rejects.toThrow("substituted run");

        const mutationFixture = storeFixture();
        mutationFixture.runs.set(
            "run-1",
            run("run-1", "queued", {
                input: "one\ntwo",
            }),
        );
        const mutationFeature = new WorkflowsFeature({
            store: {
                ...mutationFixture.store,
                transaction: async (_ctx, _agentId, work) => {
                    const callbackChange = await work(ctx());
                    return {
                        ...callbackChange,
                        run: { ...callbackChange.run, input: "one\r\ntwo" },
                    };
                },
            },
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await expect(
            mutationFeature.cancel(ctx(), OWNER, {
                id: "run-1",
                operationId: "cancel-crlf",
            }),
        ).rejects.toThrow("substituted run");
    });

    it("rejects a schema-valid substituted launch transaction event", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                transaction: async (_ctx, _agentId, work) => {
                    const callbackChange = await work(ctx());
                    if (callbackChange.event === undefined) {
                        throw new Error("launch callback did not create an event");
                    }
                    return {
                        ...callbackChange,
                        event: {
                            ...callbackChange.event,
                            eventId: "substituted-event",
                        },
                    };
                },
            },
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });

        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "run-1",
            }),
        ).rejects.toThrow("substituted event");
    });

    it("rejects schema-valid substituted cancel and resume transaction events", async () => {
        const fixture = storeFixture();
        await fixture.store.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-1",
        });
        let eventNumber = 0;
        const feature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                transaction: async (_ctx, _agentId, work) => {
                    const callbackChange = await work(ctx());
                    if (callbackChange.event === undefined) {
                        throw new Error("mutation callback did not create an event");
                    }
                    return {
                        ...callbackChange,
                        event: {
                            ...callbackChange.event,
                            eventId: `substituted-event-${++eventNumber}`,
                        },
                    };
                },
            },
            eventIdFactory: () => `event-${++eventNumber}`,
            clock: () => 1,
        });

        await expect(
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
        ).rejects.toThrow("substituted event");
        await expect(
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" }),
        ).rejects.toThrow("substituted event");
    });

    it("rejects stalled or empty cursor pages", async () => {
        const fixture = storeFixture();
        const pageCases: Array<{ readonly page: WorkflowPage; readonly cursor?: number }> = [
            { page: { agentId: OWNER, runs: [], nextCursor: 1 } },
            { page: { agentId: OWNER, runs: [run("run-1")], nextCursor: 0 } },
            { page: { agentId: OWNER, runs: [run("run-1")], nextCursor: 4 }, cursor: 5 },
        ];
        for (const { page, cursor } of pageCases) {
            const feature = new WorkflowsFeature({
                store: { ...fixture.store, list: async () => page },
            });
            await expect(
                feature.listPage(ctx(), OWNER, cursor === undefined ? {} : { cursor }),
            ).rejects.toThrow("cursor");
        }

        const logCases: Array<{ readonly page: WorkflowLogPage; readonly cursor?: number }> = [
            { page: { agentId: OWNER, id: "run-1", lines: [], nextCursor: 1 } },
            { page: { agentId: OWNER, id: "run-1", lines: ["line"], nextCursor: 0 } },
            { page: { agentId: OWNER, id: "run-1", lines: ["line"], nextCursor: 4 }, cursor: 5 },
        ];
        for (const { page, cursor } of logCases) {
            const feature = new WorkflowsFeature({
                store: { ...fixture.store, logs: async () => page },
            });
            await expect(
                feature.logs(ctx(), OWNER, {
                    id: "run-1",
                    ...(cursor === undefined ? {} : { cursor }),
                }),
            ).rejects.toThrow("cursor");
        }
    });

    it("accepts wait results only after terminal or unavailable completion", async () => {
        for (const status of ["queued", "running"] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: {
                    ...fixture.store,
                    wait: async (_ctx, agentId, id) => run(id, status, { agentId }),
                },
            });
            await expect(feature.wait(ctx(), OWNER, "run-1")).rejects.toThrow(
                "terminal or unavailable",
            );
        }
        for (const status of ["completed", "failed", "cancelled", "unavailable"] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: {
                    ...fixture.store,
                    wait: async (_ctx, agentId, id) => run(id, status, { agentId }),
                },
            });
            await expect(feature.wait(ctx(), OWNER, "run-1")).resolves.toMatchObject({ status });
        }
    });

    it("requires cancel and resume results to preserve identity and settle the requested status", async () => {
        const fixture = storeFixture();
        await fixture.store.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        const wrongStatusFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                cancel: async (_ctx, agentId, input) => ({
                    agentId,
                    operationId: input.operationId ?? "op-1",
                    run: run("run-1", "running"),
                    changed: true,
                }),
            },
        });
        await expect(
            wrongStatusFeature.cancel(ctx(), OWNER, { id: "run-1", operationId: "op-1" }),
        ).rejects.toThrow("identity or status");

        const wrongIdentityFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                resume: async (_ctx, agentId, input) => ({
                    agentId,
                    operationId: input.operationId ?? "op-1",
                    run: run("run-1", "running", { workflow: "other" }),
                    changed: true,
                }),
            },
        });
        await expect(
            wrongIdentityFeature.resume(ctx(), OWNER, { id: "run-1", operationId: "op-1" }),
        ).rejects.toThrow("mismatched");
    });

    it("keeps launch replay IDs in the durable tool call scope", async () => {
        const fixture = storeFixture();
        let idsAllocated = 0;
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => `run-${++idsAllocated}`,
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const callContext = withAgentKV(
            ctx(),
            new AgentKV(new InMemoryPersistence(), "workflow-call."),
        );
        const first = await feature.launchForTool(callContext, "agent-1", { workflow: "demo" });
        const replay = await feature.launchForTool(callContext, "agent-1", { workflow: "demo" });
        expect(idsAllocated).toBe(1);
        expect(replay).toEqual(first);
    });

    it("persists and validates the launch receipt before a store retry", async () => {
        const fixture = storeFixture();
        let idsAllocated = 0;
        let transactionCalls = 0;
        let rollback = true;
        const store: WorkflowStore = {
            ...fixture.store,
            launch: async (_ctx, agentId, input) => {
                const created = run(input.operationId ?? "generated", "queued", {
                    agentId,
                    workflow: input.workflow,
                    ...(input.input === undefined ? {} : { input: input.input }),
                });
                fixture.runs.set(created.id, created);
                return created;
            },
            transaction: async (transactionCtx, agentId, work) => {
                transactionCalls += 1;
                return await fixture.store.transaction(transactionCtx, agentId, async (txCtx) => {
                    const result = await work(txCtx);
                    if (rollback) {
                        rollback = false;
                        throw new Error("rollback before workflow receipt");
                    }
                    return result;
                });
            },
        };
        const feature = new WorkflowsFeature({
            store,
            idFactory: () => `run-${++idsAllocated}`,
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const persistence = new InMemoryPersistence();
        const callContext = withAgentKV(
            ctx(),
            new AgentKV(persistence, "workflow-launch-receipt."),
        );

        await expect(
            feature.launchForTool(callContext, OWNER, {
                workflow: "demo",
                input: "one\r\ntwo",
            }),
        ).rejects.toThrow("rollback before workflow receipt");
        expect(fixture.runs).toHaveLength(0);

        const receipt = await new AgentKV(persistence, "workflow-launch-receipt.").read(
            ctx(),
            "workflow_launch_operation_id:agent-1",
        );
        expect(Value.Check(workflowOperationReceiptSchema, receipt)).toBe(true);
        expect(receipt).toMatchObject({
            operationId: "run-1",
            fingerprint: expect.stringContaining("agent-1"),
        });

        await expect(
            feature.launchForTool(callContext, OWNER, {
                workflow: "other",
                input: "one\ntwo",
            }),
        ).rejects.toThrow("different input or target");
        expect(transactionCalls).toBe(1);

        const replay = await feature.launchForTool(callContext, OWNER, {
            workflow: "demo",
            input: "one\ntwo",
        });
        expect(replay.id).toBe("run-1");
        expect(idsAllocated).toBe(1);
        expect(transactionCalls).toBe(2);
    });

    it("persists and validates cancel and resume receipts before a store retry", async () => {
        for (const operation of ["cancel", "resume"] as const) {
            const fixture = storeFixture();
            fixture.runs.set(
                "run-1",
                run("run-1", operation === "cancel" ? "queued" : "cancelled"),
            );
            fixture.runs.set(
                "run-2",
                run("run-2", operation === "cancel" ? "queued" : "cancelled"),
            );
            let idsAllocated = 0;
            let transactionCalls = 0;
            let rollback = true;
            const store: WorkflowStore = {
                ...fixture.store,
                transaction: async (transactionCtx, agentId, work) => {
                    transactionCalls += 1;
                    return await fixture.store.transaction(
                        transactionCtx,
                        agentId,
                        async (txCtx) => {
                            const result = await work(txCtx);
                            if (rollback) {
                                rollback = false;
                                throw new Error(`rollback before ${operation} receipt`);
                            }
                            return result;
                        },
                    );
                },
            };
            const feature = new WorkflowsFeature({
                store,
                idFactory: () => `${operation}-operation-${++idsAllocated}`,
                eventIdFactory: () => `${operation}-event`,
                clock: () => 1,
            });
            const persistence = new InMemoryPersistence();
            const callContext = withAgentKV(
                ctx(),
                new AgentKV(persistence, `workflow-${operation}-receipt.`),
            );
            const apply = async (id: string): Promise<WorkflowMutationResult> =>
                operation === "cancel"
                    ? await feature.cancelForTool(callContext, OWNER, { id })
                    : await feature.resumeForTool(callContext, OWNER, { id });

            await expect(apply("run-1")).rejects.toThrow(`rollback before ${operation} receipt`);
            expect(fixture.runs.get("run-1")?.status).toBe(
                operation === "cancel" ? "queued" : "cancelled",
            );
            const receipt = await new AgentKV(persistence, `workflow-${operation}-receipt.`).read(
                ctx(),
                `workflow_${operation}_operation_id:agent-1`,
            );
            expect(Value.Check(workflowOperationReceiptSchema, receipt)).toBe(true);

            await expect(apply("run-2")).rejects.toThrow("different input or target");
            expect(transactionCalls).toBe(1);

            const replay = await apply("run-1");
            expect(replay.operationId).toBe(`${operation}-operation-1`);
            expect(replay.changed).toBe(true);
            expect(idsAllocated).toBe(1);
            expect(transactionCalls).toBe(2);
        }
    });

    it("rejects legacy string operation receipts", async () => {
        const fixture = storeFixture();
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "workflow-legacy-receipt.");
        await kv.write(ctx(), "workflow_launch_operation_id:agent-1", "run-legacy");
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-new",
        });

        await expect(
            feature.launchForTool(withAgentKV(ctx(), kv), OWNER, { workflow: "demo" }),
        ).rejects.toThrow("operation receipt is invalid");
        expect(fixture.runs).toHaveLength(0);
    });

    it("keeps generated model receipts separate for each agent", async () => {
        const fixture = storeFixture();
        let idsAllocated = 0;
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => `run-${++idsAllocated}`,
            eventIdFactory: () => `event-${++idsAllocated}`,
            clock: () => 1,
        });
        const persistence = new InMemoryPersistence();
        const ownerContext = withAgentKV(ctx(), new AgentKV(persistence, "workflow-shared-call."));
        const otherContext = withAgentKV(ctx(), new AgentKV(persistence, "workflow-shared-call."));
        const ownerRun = await feature.launchForTool(ownerContext, OWNER, { workflow: "demo" });
        const otherRun = await feature.launchForTool(otherContext, "agent-2", {
            workflow: "demo",
        });
        expect(ownerRun.id).not.toBe(otherRun.id);
        expect(ownerRun.agentId).toBe(OWNER);
        expect(otherRun.agentId).toBe("agent-2");
        expect(idsAllocated).toBe(4);
    });

    it("replays stop after an opposite transition without a duplicate event", async () => {
        const fixture = storeFixture();
        let idsAllocated = 0;
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => `operation-${++idsAllocated}`,
            eventIdFactory: () => `event-${fixture.events.length + 1}`,
            clock: () => 1,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    fixture.events.push(event);
                },
            },
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        const stopPersistence = new InMemoryPersistence();
        const stopCtx = withAgentKV(ctx(), new AgentKV(stopPersistence, "workflow-stop-call."));
        const resumePersistence = new InMemoryPersistence();
        const resumeCtx = withAgentKV(
            ctx(),
            new AgentKV(resumePersistence, "workflow-resume-call."),
        );

        const stopped = await feature.cancelForTool(stopCtx, OWNER, { id: "run-1" });
        const resumed = await feature.resumeForTool(resumeCtx, OWNER, { id: "run-1" });
        const replayed = await feature.cancelForTool(stopCtx, OWNER, { id: "run-1" });

        expect(stopped.run.status).toBe("cancelled");
        expect(resumed.run.status).toBe("running");
        expect(replayed).toEqual({
            agentId: OWNER,
            operationId: stopped.operationId,
            run: stopped.run,
            changed: false,
        });
        expect(fixture.runs.get("run-1")?.status).toBe("running");
        expect(idsAllocated).toBe(2);
        expect(fixture.events).toHaveLength(3);
    });

    it("consults the durable receipt when the current target already matches", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            eventIdFactory: () => `event-${fixture.events.length + 1}`,
            clock: () => 1,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    fixture.events.push(event);
                },
            },
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });

        const cancelledA = await feature.cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "operation-a",
        });
        const resumedB = await feature.resume(ctx(), OWNER, {
            id: "run-1",
            operationId: "operation-b",
        });
        const cancelledC = await feature.cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "operation-c",
        });
        const replayedA = await feature.cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "operation-a",
        });

        expect(cancelledA).toMatchObject({
            operationId: "operation-a",
            changed: true,
        });
        expect(resumedB).toMatchObject({
            operationId: "operation-b",
            changed: true,
        });
        expect(cancelledC.run.updatedAt).not.toBe(cancelledA.run.updatedAt);
        expect(replayedA).toEqual({
            agentId: OWNER,
            operationId: cancelledA.operationId,
            run: cancelledA.run,
            changed: false,
        });
        expect(fixture.mutationCalls.map(({ operationId }) => operationId)).toEqual([
            "operation-a",
            "operation-b",
            "operation-c",
            "operation-a",
        ]);
        expect(fixture.events).toHaveLength(4);

        await expect(
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "operation-a" }),
        ).rejects.toThrow("different target/input");
        await expect(
            feature.cancel(ctx(), OWNER, { id: "other-run", operationId: "operation-a" }),
        ).rejects.toThrow("different target/input");
    });

    it("leaves concurrent mutations to the injected transaction serialization", async () => {
        const fixture = storeFixture();
        let queue: Promise<void> = Promise.resolve();
        const serializedStore: WorkflowStore = {
            ...fixture.store,
            transaction: async (_ctx, _agentId, work) => {
                const previous = queue;
                let release!: () => void;
                queue = new Promise<void>((resolve) => {
                    release = resolve;
                });
                await previous;
                try {
                    return await fixture.store.transaction(ctx(), OWNER, work);
                } finally {
                    release();
                }
            },
        };
        const feature = new WorkflowsFeature({
            store: serializedStore,
            eventIdFactory: () => `event-${fixture.events.length + 1}`,
            clock: () => 1,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    fixture.events.push(event);
                },
            },
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        const [cancelled, resumed] = await Promise.all([
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" }),
        ]);
        expect(cancelled.run.status).toBe("cancelled");
        expect(resumed.run.status).toBe("running");
        expect(fixture.events).toHaveLength(3);
    });

    it("does not publish a nested mutation after the outer transaction rolls back", async () => {
        const fixture = storeFixture();
        let depth = 0;
        const store: WorkflowStore = {
            ...fixture.store,
            transaction: async (_ctx, _agentId, work) => {
                const outer = depth === 0;
                const before = new Map(fixture.runs);
                const callbackCount = fixture.callbacks.length;
                depth += 1;
                try {
                    const result = await work(ctx());
                    depth -= 1;
                    return result;
                } catch (error: unknown) {
                    fixture.runs.clear();
                    for (const [id, value] of before) fixture.runs.set(id, value);
                    fixture.callbacks.splice(callbackCount);
                    depth -= 1;
                    if (!outer) throw error;
                    throw error;
                }
            },
        };
        const feature = new WorkflowsFeature({
            store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await expect(
            store.transaction(ctx(), OWNER, async (txCtx) => {
                await feature.launch(txCtx, OWNER, { workflow: "demo", operationId: "run-1" });
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");
        expect(fixture.runs).toHaveLength(0);
        expect(fixture.callbacks).toHaveLength(0);
    });

    it("keeps maximum identities visible within the minimum model budget", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            maxOutputCharacters: 256,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const id = "i".repeat(MAX_WORKFLOW_ID_LENGTH);
        const workflow = "w".repeat(MAX_WORKFLOW_NAME_LENGTH);
        const maximum = run(id, "unavailable", { workflow });
        const runText = feature.formatRunForModel(maximum);
        expect(runText.startsWith(id)).toBe(true);
        expect(runText).toContain(workflow);
        expect(runText.length).toBeLessThanOrEqual(256);
        const pageText = feature.formatPageForModel({
            agentId: OWNER,
            runs: [maximum],
            nextCursor: 1,
        });
        expect(pageText.startsWith(id)).toBe(true);
        expect(pageText).toContain(workflow);
        expect(pageText.length).toBeLessThanOrEqual(256);
        const logText = feature.formatLogsForModel({
            agentId: OWNER,
            id,
            lines: ["x".repeat(4_000)],
            nextCursor: 1,
        });
        expect(logText.startsWith(id)).toBe(true);
        expect(logText.length).toBeLessThanOrEqual(256);
        const names = feature
            .tools(ctx(), { agent: { id: "agent-1" } } as never)
            .map((tool) => tool.name);
        expect(names).toContain("resume_workflow");
        expect(
            feature
                .tools(ctx(), { agent: { id: "agent-1" } } as never)
                .find((tool) => tool.name === "stop_workflow")?.returnType,
        ).toBe(workflowMutationResultSchema);
    });

    it("bounds pages and logs at the feature boundary", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            maxPageSize: 1,
            maxLogLines: 1,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        await expect(feature.listPage(ctx(), OWNER, { limit: 2 })).rejects.toThrow("exceeds");
        const logs = await feature.logs(ctx(), OWNER, { id: "run-1", limit: 1 });
        expect(logs.lines).toEqual(["hello"]);
    });

    it("rolls back the host mutation and drops post-commit publication on listener failure", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
            listener: {
                onEventTransactional: () => {
                    throw new Error("projection failed");
                },
            },
        });
        await expect(
            feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" }),
        ).rejects.toThrow("projection failed");
        expect(fixture.runs.size).toBe(0);
        expect(fixture.callbacks).toHaveLength(0);
    });

    it("contains post-commit observer failures and reports them", async () => {
        const fixture = storeFixture();
        const errors: unknown[] = [];
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
            listener: { onEvent: () => Promise.reject(new Error("observer failed")) },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(error);
            },
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        await fixture.callbacks[0]!(ctx());
        expect(errors).toHaveLength(1);
    });

    it("supports status, cancellation, resume, waiting, and bounded logs", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            idFactory: () => "run-1",
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        await feature.launch(ctx(), OWNER, { workflow: "demo", operationId: "run-1" });
        expect((await feature.get(ctx(), OWNER, "run-1"))?.status).toBe("queued");
        expect(
            (await feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" })).run
                .status,
        ).toBe("cancelled");
        expect(
            (await feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" })).run
                .status,
        ).toBe("running");
        fixture.runs.set("run-1", run("run-1", "completed", { updatedAt: 3 }));
        expect((await feature.wait(ctx(), OWNER, "run-1")).id).toBe("run-1");
    });
});
