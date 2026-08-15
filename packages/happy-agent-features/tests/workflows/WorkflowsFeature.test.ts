import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_CURSOR,
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH,
    MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    workflowCallOperationSchema,
    workflowCursorSchema,
    workflowLogQuerySchema,
    workflowMutationProofSchema,
    workflowMutationResultSchema,
    workflowOperationFingerprintSchema,
    workflowOperationReceiptSchema,
    workflowPostCommitErrorSchema,
    workflowPageQuerySchema,
    workflowPausedRunSchema,
    workflowRunSchema,
    type WorkflowEvent,
    type WorkflowStore,
    type WorkflowMutationProof,
    type WorkflowOperationReceipt,
} from "../../sources/workflows/index.js";
import * as RootExports from "../../sources/index.js";
import {
    WorkflowsFeature as RootWorkflowsFeature,
    cancelWorkflowTool as rootCancelWorkflowTool,
    listWorkflowsTool as rootListWorkflowsTool,
    resumeWorkflowTool as rootResumeWorkflowTool,
    runWorkflowTool as rootRunWorkflowTool,
    waitWorkflowTool as rootWaitWorkflowTool,
    workflowFeatureOptionsSchema as rootWorkflowFeatureOptionsSchema,
    workflowLogsTool as rootWorkflowLogsTool,
    workflowMutationResultSchema as rootWorkflowMutationResultSchema,
    workflowMutationProofSchema as rootWorkflowMutationProofSchema,
    workflowCallOperationSchema as rootWorkflowCallOperationSchema,
    workflowOperationFingerprintSchema as rootWorkflowOperationFingerprintSchema,
    workflowOperationReceiptSchema as rootWorkflowOperationReceiptSchema,
    workflowPostCommitErrorSchema as rootWorkflowPostCommitErrorSchema,
    workflowRunSchema as rootWorkflowRunSchema,
    workflowStatusTool as rootWorkflowStatusTool,
    workflowStoreSchema as rootWorkflowStoreSchema,
    MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH as rootMaxWorkflowOperationFingerprintLength,
    MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH as rootMaxWorkflowPostCommitErrorLength,
    type WorkflowOperationFingerprint as RootWorkflowOperationFingerprint,
    type WorkflowCallOperation as RootWorkflowCallOperation,
    type WorkflowMutationProof as RootWorkflowMutationProof,
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
    overrides: {
        readonly agentId?: string;
        readonly workflow?: string;
        readonly input?: string;
        readonly output?: string;
        readonly error?: string;
        readonly createdAt?: number;
        readonly updatedAt?: number;
        readonly startedAt?: number;
        readonly pausedAt?: number;
        readonly finishedAt?: number;
    } = {},
): WorkflowRun {
    const createdAt = overrides.createdAt ?? 1;
    const common = {
        id,
        agentId: overrides.agentId ?? "agent-1",
        workflow: overrides.workflow ?? "demo",
        ...(overrides.input === undefined ? {} : { input: overrides.input }),
        createdAt,
    };
    if (status === "queued") {
        return { ...common, status, updatedAt: overrides.updatedAt ?? createdAt };
    }
    const startedAt = overrides.startedAt ?? createdAt;
    const output = overrides.output === undefined ? {} : { output: overrides.output };
    if (status === "running") {
        return {
            ...common,
            status,
            startedAt,
            ...output,
            updatedAt: overrides.updatedAt ?? startedAt,
        };
    }
    if (status === "paused") {
        const updatedAt = overrides.updatedAt ?? 2;
        return {
            ...common,
            status,
            startedAt,
            pausedAt: overrides.pausedAt ?? updatedAt,
            ...output,
            updatedAt,
        };
    }
    const updatedAt = overrides.updatedAt ?? 2;
    const finishedAt = overrides.finishedAt ?? updatedAt;
    if (status === "completed") {
        return { ...common, status, startedAt, finishedAt, ...output, updatedAt };
    }
    if (status === "failed") {
        return {
            ...common,
            status,
            startedAt,
            finishedAt,
            ...output,
            error: overrides.error ?? "failed",
            updatedAt,
        };
    }
    const optionalStart = overrides.startedAt === undefined ? {} : { startedAt };
    if (status === "cancelled") {
        return { ...common, status, ...optionalStart, finishedAt, ...output, updatedAt };
    }
    return {
        ...common,
        status,
        ...optionalStart,
        finishedAt,
        ...output,
        ...(overrides.error === undefined ? {} : { error: overrides.error }),
        updatedAt,
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
    const receipts = new Map<string, WorkflowOperationReceipt>();
    const proofs = new Map<string, WorkflowMutationProof>();
    let launchCalls = 0;
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
        const noOp =
            (operation === "cancel" &&
                ["completed", "failed", "cancelled", "unavailable"].includes(current.status)) ||
            (operation === "resume" && current.status === "running");
        if (noOp) {
            mutationResults.set(key, current);
            mutationInputs.set(key, { operation, id: input.id });
            return { agentId, operationId, run: current, changed: false };
        }
        if (operation === "resume" && current.status !== "paused") {
            throw new Error("only paused runs can resume");
        }
        mutationVersion = Math.max(mutationVersion, current.updatedAt) + 1;
        const next: WorkflowRun =
            operation === "cancel"
                ? {
                      id: current.id,
                      agentId: current.agentId,
                      workflow: current.workflow,
                      ...(current.input === undefined ? {} : { input: current.input }),
                      status: "cancelled",
                      ...("startedAt" in current && current.startedAt !== undefined
                          ? { startedAt: current.startedAt }
                          : {}),
                      ...("output" in current && current.output !== undefined
                          ? { output: current.output }
                          : {}),
                      createdAt: current.createdAt,
                      updatedAt: mutationVersion,
                      finishedAt: mutationVersion,
                  }
                : {
                      id: current.id,
                      agentId: current.agentId,
                      workflow: current.workflow,
                      ...(current.input === undefined ? {} : { input: current.input }),
                      status: "running",
                      startedAt: "startedAt" in current ? current.startedAt : current.createdAt,
                      ...("output" in current && current.output !== undefined
                          ? { output: current.output }
                          : {}),
                      createdAt: current.createdAt,
                      updatedAt: mutationVersion,
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
            const beforeReceipts = new Map(receipts);
            const beforeProofs = new Map(proofs);
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
                receipts.clear();
                for (const [id, value] of beforeReceipts) receipts.set(id, value);
                proofs.clear();
                for (const [id, value] of beforeProofs) proofs.set(id, value);
                mutationVersion = beforeMutationVersion;
                callbacks.splice(callbackCount);
                throw error;
            }
        },
        afterCommit: (_ctx, callback) => {
            callbacks.push(callback);
        },
        launch: async (_ctx, agentId, input: WorkflowLaunchInput) => {
            launchCalls += 1;
            const created = run(input.operationId ?? "generated", "queued", {
                agentId,
                workflow: input.workflow,
                ...(input.input === undefined ? {} : { input: input.input }),
            });
            runs.set(created.id, created);
            return created;
        },
        get: async (_ctx, agentId, id) => {
            const value = runs.get(id);
            return value?.agentId === agentId ? value : undefined;
        },
        list: async (_ctx, agentId, query: WorkflowPageQuery): Promise<WorkflowPage> => {
            const ownedRuns = [...runs.values()]
                .filter(
                    (value) =>
                        value.agentId === agentId &&
                        (query.includeTerminal !== false ||
                            !["completed", "failed", "cancelled", "unavailable"].includes(
                                value.status,
                            )),
                )
                .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
            const totalRuns = ownedRuns.length;
            const limit = query.limit ?? 50;
            const cursor =
                query.from === "end"
                    ? Math.max(0, totalRuns - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const pageRuns = ownedRuns.slice(cursor, cursor + limit);
            return {
                agentId,
                cursor,
                runs: pageRuns,
                totalRuns,
                ...(cursor + pageRuns.length < totalRuns
                    ? { nextCursor: cursor + pageRuns.length }
                    : {}),
                ...(Math.min(cursor, totalRuns) === 0
                    ? {}
                    : { previousCursor: Math.max(0, Math.min(cursor, totalRuns) - limit) }),
            };
        },
        cancel: async (_ctx, agentId, input) => await mutate(agentId, "cancel", input),
        resume: async (_ctx, agentId, input) => await mutate(agentId, "resume", input),
        wait: async (_ctx, agentId, id) =>
            runs.get(id)?.agentId === agentId ? runs.get(id)! : run(id, "unavailable", { agentId }),
        logs: async (_ctx, agentId, query): Promise<WorkflowLogPage> => {
            const totalLines = 1;
            const limit = query.limit ?? 50;
            const cursor =
                query.from === "end"
                    ? Math.max(0, totalLines - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const lines = cursor === 0 && limit > 0 ? [{ position: 0, text: "hello" }] : [];
            return {
                agentId,
                id: query.id,
                cursor,
                lines,
                totalLines,
                ...(cursor + lines.length < totalLines
                    ? { nextCursor: cursor + lines.length }
                    : {}),
                ...(Math.min(cursor, totalLines) === 0
                    ? {}
                    : { previousCursor: Math.max(0, Math.min(cursor, totalLines) - limit) }),
            };
        },
        readReceipt: async (_ctx, agentId, operationId) =>
            structuredClone(receipts.get(receiptKey(agentId, operationId))),
        writeReceipt: async (_ctx, agentId, receipt) => {
            const key = receiptKey(agentId, receipt.operationId);
            const previous = receipts.get(key);
            if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(receipt)) {
                throw new Error("receipt conflict");
            }
            receipts.set(key, structuredClone(receipt));
        },
        readMutationProof: async (_ctx, agentId, operationId) =>
            structuredClone(proofs.get(receiptKey(agentId, operationId))),
        writeMutationProof: async (_ctx, agentId, proof) => {
            const key = receiptKey(agentId, proof.operationId);
            const previous = proofs.get(key);
            if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(proof)) {
                throw new Error("proof conflict");
            }
            proofs.set(key, structuredClone(proof));
        },
    };
    return {
        store,
        runs,
        mutationResults,
        mutationCalls,
        callbacks,
        events,
        receipts,
        proofs,
        get launchCalls() {
            return launchCalls;
        },
    };
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
        expect(rootWorkflowCallOperationSchema).toBe(workflowCallOperationSchema);
        expect(rootWorkflowOperationReceiptSchema).toBe(workflowOperationReceiptSchema);
        expect(rootWorkflowMutationProofSchema).toBe(workflowMutationProofSchema);
        expect(rootWorkflowPostCommitErrorSchema).toBe(workflowPostCommitErrorSchema);
        expect(rootMaxWorkflowPostCommitErrorLength).toBe(MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH);
        expect(MAX_WORKFLOW_CURSOR).toBe(Number.MAX_SAFE_INTEGER);
        expect(Value.Check(workflowCursorSchema, Number.MAX_SAFE_INTEGER)).toBe(true);
        expect(RootExports.workflowPausedRunSchema).toBe(workflowPausedRunSchema);
        expect(
            Value.Check(
                workflowRunSchema,
                run("paused-run", "paused", { startedAt: 1, pausedAt: 2, updatedAt: 2 }),
            ),
        ).toBe(true);
        expect(
            Value.Check(workflowRunSchema, {
                id: "invalid-queued",
                agentId: OWNER,
                workflow: "demo",
                status: "queued",
                output: "not allowed",
                createdAt: 1,
                updatedAt: 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(workflowRunSchema, {
                id: "invalid-paused",
                agentId: OWNER,
                workflow: "demo",
                status: "paused",
                startedAt: 1,
                createdAt: 1,
                updatedAt: 2,
            }),
        ).toBe(false);
        expect(
            Value.Check(workflowRunSchema, {
                id: "invalid-failed",
                agentId: OWNER,
                workflow: "demo",
                status: "failed",
                startedAt: 1,
                finishedAt: 2,
                createdAt: 1,
                updatedAt: 2,
            }),
        ).toBe(false);
        expect(Value.Check(workflowPageQuerySchema, { from: "end", cursor: 0 })).toBe(false);
        expect(
            Value.Check(workflowLogQuerySchema, {
                id: "run-1",
                from: "end",
                cursor: 0,
            }),
        ).toBe(false);
        const operationFingerprint: RootWorkflowOperationFingerprint = "a".repeat(64);
        const callOperation: RootWorkflowCallOperation = {
            operationId: "run-1",
            fingerprint: operationFingerprint,
        };
        const operationReceipt: RootWorkflowOperationReceipt = {
            agentId: OWNER,
            operation: "launch",
            operationId: "run-1",
            fingerprint: operationFingerprint,
            result: run("run-1"),
        };
        const mutationProof: RootWorkflowMutationProof = {
            agentId: OWNER,
            operation: "launch",
            operationId: "run-1",
            fingerprint: operationFingerprint,
            beforeExists: false,
            after: run("run-1"),
            changed: true,
            result: run("run-1"),
        };
        expect(callOperation.operationId).toBe("run-1");
        expect(Value.Check(workflowOperationReceiptSchema, operationReceipt)).toBe(true);
        expect(Value.Check(workflowMutationProofSchema, mutationProof)).toBe(true);
        expect(typeof rootWorkflowStoreSchema).toBe("object");
        const fixture = storeFixture();
        const rootStore: RootWorkflowStore = fixture.store;
        expect(rootStore).toBe(fixture.store);
        expect(typeof rootRunWorkflowTool).toBe("function");
        expect(typeof rootListWorkflowsTool).toBe("function");
        expect(typeof rootCancelWorkflowTool).toBe("function");
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

        expect(await feature.status(ctx(), "agent-2", "run-1")).toBeUndefined();
        expect(await feature.list(ctx(), "agent-2", { cursor: 0 })).toEqual({
            agentId: "agent-2",
            cursor: 0,
            runs: [],
            totalRuns: 0,
        });
        await expect(
            feature.cancel(ctx(), "agent-2", { id: "run-1", operationId: "agent-2-cancel" }),
        ).rejects.toThrow("not found");
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
                list: async () => ({
                    agentId: OWNER,
                    cursor: 0,
                    runs: [foreignRun],
                    totalRuns: 1,
                }),
                wait: async () => foreignRun,
                logs: async () => ({
                    agentId: OWNER,
                    id: foreignRun.id,
                    cursor: 0,
                    lines: [{ position: 0, text: "foreign" }],
                    totalLines: 1,
                }),
            },
        });
        await expect(foreignFeature.status(ctx(), "agent-2", "run-1")).rejects.toThrow(
            "another agent",
        );
        await expect(foreignFeature.list(ctx(), "agent-2")).rejects.toThrow("another agent");
        await expect(foreignFeature.wait(ctx(), "agent-2", "run-1")).rejects.toThrow(
            "another agent",
        );
        await expect(foreignFeature.logs(ctx(), "agent-2", { id: "run-1" })).rejects.toThrow(
            "outside the requested bound",
        );

        const foreignMutationFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                get: async (_ctx, agentId, id) => run(id, "queued", { agentId, workflow: "demo" }),
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

    it("rejects schema-valid persisted runs with impossible lifecycle timestamps", async () => {
        const fixture = storeFixture();
        const malformedPaused = run("paused", "paused", {
            pausedAt: 1,
            updatedAt: 2,
        });
        expect(Value.Check(workflowRunSchema, malformedPaused)).toBe(true);
        const feature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                get: async () => malformedPaused,
            },
        });
        await expect(feature.status(ctx(), OWNER, "paused")).rejects.toThrow("pause time");
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
        const result = await feature.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-1",
        });
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
        ).rejects.toThrow("does not match");
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
        ).rejects.toThrow("does not match");
        expect(
            await feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "one\ntwo",
                operationId: "run-1",
            }),
        ).toEqual(first);
    });

    it("isolates normalized launch and mutation requests from hostile host mutation", async () => {
        const launchFixture = storeFixture();
        const launchInput: WorkflowLaunchInput = {
            workflow: "demo",
            operationId: "run-1",
        };
        const launchFeature = new WorkflowsFeature({
            store: {
                ...launchFixture.store,
                launch: async (_ctx, agentId, input) => {
                    input.workflow = "tampered";
                    const created = run(input.operationId, "queued", {
                        agentId,
                        workflow: input.workflow,
                    });
                    launchFixture.runs.set(created.id, created);
                    return created;
                },
            },
        });
        await expect(launchFeature.launch(ctx(), OWNER, launchInput)).rejects.toThrow(
            "wrong identity or input",
        );
        expect(launchInput).toEqual({ workflow: "demo", operationId: "run-1" });
        expect(launchFixture.runs).toHaveLength(0);

        const mutationFixture = storeFixture();
        mutationFixture.runs.set("run-1", run("run-1"));
        mutationFixture.runs.set("run-2", run("run-2"));
        const mutationInput: WorkflowMutationInput = {
            id: "run-1",
            operationId: "cancel-1",
        };
        const mutationFeature = new WorkflowsFeature({
            store: {
                ...mutationFixture.store,
                cancel: async (storeCtx, agentId, input) => {
                    input.id = "run-2";
                    return await mutationFixture.store.cancel(storeCtx, agentId, input);
                },
            },
        });
        await expect(mutationFeature.cancel(ctx(), OWNER, mutationInput)).rejects.toThrow(
            "wrong run",
        );
        expect(mutationInput).toEqual({ id: "run-1", operationId: "cancel-1" });
        expect(mutationFixture.runs.get("run-1")?.status).toBe("queued");
        expect(mutationFixture.runs.get("run-2")?.status).toBe("queued");
    });

    it("requires host operation IDs before allocation or runner mutation", async () => {
        const fixture = storeFixture();
        fixture.runs.set("run-1", run("run-1"));
        let idsAllocated = 0;
        let transactions = 0;
        const feature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                transaction: async (transactionCtx, agentId, work) => {
                    transactions += 1;
                    return await fixture.store.transaction(transactionCtx, agentId, work);
                },
            },
            idFactory: () => `operation-${++idsAllocated}`,
        });

        await expect(feature.launch(ctx(), OWNER, { workflow: "demo" })).rejects.toThrow(
            "require an operation ID",
        );
        await expect(feature.cancel(ctx(), OWNER, { id: "run-1" })).rejects.toThrow(
            "require an operation ID",
        );
        await expect(feature.resume(ctx(), OWNER, { id: "run-1" })).rejects.toThrow(
            "require an operation ID",
        );
        expect(idsAllocated).toBe(0);
        expect(transactions).toBe(0);
        expect(fixture.launchCalls).toBe(0);
        expect(fixture.mutationCalls).toHaveLength(0);

        for (const [name, input] of [
            ["run_workflow", { workflow: "demo", operationId: "model-op" }],
            ["cancel_workflow", { id: "run-1", operationId: "model-op" }],
            ["resume_workflow", { id: "run-1", operationId: "model-op" }],
        ] as const) {
            const tool = feature
                .tools(ctx(), { agent: { id: OWNER } } as never)
                .find((candidate) => candidate.name === name);
            expect(tool).toBeDefined();
            expect(Value.Check(tool!.parameters, input)).toBe(false);
        }
    });

    it("replays a launch from exact receipt and proof after current state is removed", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            eventIdFactory: () => "event-1",
            clock: () => 1,
        });
        const first = await feature.launch(ctx(), OWNER, {
            workflow: "demo",
            input: "input",
            operationId: "run-1",
        });
        const key = `${OWNER}:run-1`;
        const originalReceipt = structuredClone(fixture.receipts.get(key)!);
        const originalProof = structuredClone(fixture.proofs.get(key)!);
        if (originalReceipt.operation !== "launch") throw new Error("expected launch receipt");
        fixture.runs.delete("run-1");

        const replay = await new WorkflowsFeature({ store: fixture.store }).launch(ctx(), OWNER, {
            workflow: "demo",
            input: "input",
            operationId: "run-1",
        });
        expect(replay).toEqual(first);
        expect(fixture.launchCalls).toBe(1);
        expect(fixture.runs.has("run-1")).toBe(false);

        fixture.receipts.set(key, {
            ...originalReceipt,
            result: { ...first, workflow: "tampered" },
        });
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "input",
                operationId: "run-1",
            }),
        ).rejects.toThrow("inconsistent");

        fixture.receipts.set(key, originalReceipt);
        fixture.proofs.delete(key);
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "input",
                operationId: "run-1",
            }),
        ).rejects.toThrow("incomplete");

        fixture.proofs.set(key, originalProof);
        fixture.receipts.delete(key);
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: "input",
                operationId: "run-1",
            }),
        ).rejects.toThrow("incomplete");
    });

    it("hashes maximum escaped workflow input into a fixed durable fingerprint", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({ store: fixture.store });
        const input = "\0".repeat(20_000);
        const first = await feature.launch(ctx(), OWNER, {
            workflow: "demo",
            input,
            operationId: "run-max-input",
        });
        expect(first.input).toBe(input);
        const receipt = fixture.receipts.get(`${OWNER}:run-max-input`);
        expect(receipt?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input,
                operationId: "run-max-input",
            }),
        ).resolves.toEqual(first);
        await expect(
            feature.launch(ctx(), OWNER, {
                workflow: "demo",
                input: `${input.slice(0, -1)}x`,
                operationId: "run-max-input",
            }),
        ).rejects.toThrow("does not match");
    });

    it("replays historical mutation results and rejects missing or tampered evidence", async () => {
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
        const cancelled = await feature.cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "cancel-1",
        });
        fixture.runs.set("run-1", run("run-1", "running", { startedAt: 1, updatedAt: 3 }));
        const key = `${OWNER}:cancel-1`;
        const originalReceipt = structuredClone(fixture.receipts.get(key)!);
        const originalProof = structuredClone(fixture.proofs.get(key)!);
        const callsBeforeReplay = fixture.mutationCalls.length;
        const eventsBeforeReplay = fixture.events.length;

        if (originalReceipt.operation !== "cancel") throw new Error("expected cancel receipt");
        fixture.receipts.set(key, {
            ...originalReceipt,
            result: { ...originalReceipt.result, changed: false },
        });
        await expect(
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
        ).rejects.toThrow("inconsistent");

        fixture.receipts.set(key, originalReceipt);
        fixture.proofs.delete(key);
        await expect(
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
        ).rejects.toThrow("incomplete");

        fixture.proofs.set(key, originalProof);
        const replay = await feature.cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "cancel-1",
        });
        expect(replay).toEqual(cancelled);
        expect(fixture.runs.get("run-1")?.status).toBe("running");
        expect(fixture.mutationCalls).toHaveLength(callsBeforeReplay);
        expect(fixture.events).toHaveLength(eventsBeforeReplay);
    });

    it("rejects schema-valid replay evidence whose nested runs belong to another agent", async () => {
        const launchFixture = storeFixture();
        await new WorkflowsFeature({ store: launchFixture.store }).launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-foreign-launch",
        });
        const launchKey = `${OWNER}:run-foreign-launch`;
        const launchReceipt = launchFixture.receipts.get(launchKey);
        const launchProof = launchFixture.proofs.get(launchKey);
        if (launchReceipt?.operation !== "launch" || launchProof?.operation !== "launch") {
            throw new Error("expected launch evidence");
        }
        const foreignLaunchReceipt: WorkflowOperationReceipt = {
            ...launchReceipt,
            result: { ...launchReceipt.result, agentId: "agent-2" },
        };
        const foreignLaunchProof: WorkflowMutationProof = {
            ...launchProof,
            after: { ...launchProof.after, agentId: "agent-2" },
            result: { ...launchProof.result, agentId: "agent-2" },
        };
        expect(Value.Check(workflowOperationReceiptSchema, foreignLaunchReceipt)).toBe(true);
        expect(Value.Check(workflowMutationProofSchema, foreignLaunchProof)).toBe(true);
        launchFixture.receipts.set(launchKey, foreignLaunchReceipt);
        launchFixture.proofs.set(launchKey, foreignLaunchProof);
        await expect(
            new WorkflowsFeature({ store: launchFixture.store }).launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "run-foreign-launch",
            }),
        ).rejects.toThrow("another agent");

        const mutationFixture = storeFixture();
        const mutationFeature = new WorkflowsFeature({ store: mutationFixture.store });
        await mutationFeature.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "run-foreign-mutation",
        });
        await mutationFeature.cancel(ctx(), OWNER, {
            id: "run-foreign-mutation",
            operationId: "cancel-foreign",
        });
        const mutationKey = `${OWNER}:cancel-foreign`;
        const mutationReceipt = mutationFixture.receipts.get(mutationKey);
        const mutationProof = mutationFixture.proofs.get(mutationKey);
        if (mutationReceipt?.operation !== "cancel" || mutationProof?.operation !== "cancel") {
            throw new Error("expected cancel evidence");
        }
        const foreignMutationReceipt: WorkflowOperationReceipt = {
            ...mutationReceipt,
            result: {
                ...mutationReceipt.result,
                agentId: "agent-2",
                run: { ...mutationReceipt.result.run, agentId: "agent-2" },
            },
        };
        const foreignMutationProof: WorkflowMutationProof = {
            ...mutationProof,
            before: { ...mutationProof.before, agentId: "agent-2" },
            after: { ...mutationProof.after, agentId: "agent-2" },
            result: {
                ...mutationProof.result,
                agentId: "agent-2",
                run: { ...mutationProof.result.run, agentId: "agent-2" },
            },
        };
        expect(Value.Check(workflowOperationReceiptSchema, foreignMutationReceipt)).toBe(true);
        expect(Value.Check(workflowMutationProofSchema, foreignMutationProof)).toBe(true);
        mutationFixture.receipts.set(mutationKey, foreignMutationReceipt);
        mutationFixture.proofs.set(mutationKey, foreignMutationProof);
        await expect(
            new WorkflowsFeature({ store: mutationFixture.store }).cancel(ctx(), OWNER, {
                id: "run-foreign-mutation",
                operationId: "cancel-foreign",
            }),
        ).rejects.toThrow("wrong identity");
    });

    it("persists exact proof and receipt readbacks or rolls the runner mutation back", async () => {
        for (const missing of ["proof", "receipt"] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: {
                    ...fixture.store,
                    ...(missing === "proof"
                        ? { writeMutationProof: async () => undefined }
                        : { writeReceipt: async () => undefined }),
                },
                eventIdFactory: () => "event-1",
                clock: () => 1,
            });

            await expect(
                feature.launch(ctx(), OWNER, {
                    workflow: "demo",
                    operationId: `run-${missing}`,
                }),
            ).rejects.toThrow("durably retain");
            expect(fixture.runs).toHaveLength(0);
            expect(fixture.receipts).toHaveLength(0);
            expect(fixture.proofs).toHaveLength(0);
            expect(fixture.callbacks).toHaveLength(0);
        }
    });

    it("derives mutation changes from authoritative before and after state", async () => {
        const fixture = storeFixture();
        fixture.runs.set("run-1", run("run-1"));
        const feature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                cancel: async (_ctx, agentId, input) => {
                    const after = run(input.id, "cancelled", { agentId, updatedAt: 2 });
                    fixture.runs.set(input.id, after);
                    return {
                        agentId,
                        operationId: input.operationId,
                        run: after,
                        changed: false,
                    };
                },
            },
        });
        await expect(
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
        ).rejects.toThrow("authoritative transition");
        expect(fixture.runs.get("run-1")?.status).toBe("queued");
        expect(fixture.receipts).toHaveLength(0);
        expect(fixture.proofs).toHaveLength(0);

        fixture.runs.set("run-1", run("run-1", "cancelled", { updatedAt: 2 }));
        const noOp = await new WorkflowsFeature({ store: fixture.store }).cancel(ctx(), OWNER, {
            id: "run-1",
            operationId: "cancel-no-op",
        });
        expect(noOp.changed).toBe(false);
        expect(noOp.run.updatedAt).toBe(2);
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

    it("requires Promise-returning store methods and validates their resolved values", async () => {
        const transactionFixture = storeFixture();
        const synchronousTransaction = new WorkflowsFeature({
            store: {
                ...transactionFixture.store,
                transaction: (() => ({
                    agentId: OWNER,
                    operationId: "run-1",
                    run: run("run-1"),
                    changed: false,
                })) as unknown as WorkflowStore["transaction"],
            },
        });
        await expect(
            synchronousTransaction.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "run-1",
            }),
        ).rejects.toThrow("transaction must return a Promise");

        const readFixture = storeFixture();
        const synchronousRead = new WorkflowsFeature({
            store: {
                ...readFixture.store,
                get: (() => run("run-1")) as unknown as WorkflowStore["get"],
            },
        });
        await expect(synchronousRead.status(ctx(), OWNER, "run-1")).rejects.toThrow(
            "get must return a Promise",
        );
        const malformedRead = new WorkflowsFeature({
            store: {
                ...readFixture.store,
                get: async () => ({ invalid: true }) as never,
            },
        });
        await expect(malformedRead.status(ctx(), OWNER, "run-1")).rejects.toThrow("invalid run");

        const mutationFixture = storeFixture();
        mutationFixture.runs.set("run-1", run("run-1"));
        const synchronousMutation = new WorkflowsFeature({
            store: {
                ...mutationFixture.store,
                cancel: ((_ctx: Context, agentId: string, input: WorkflowMutationInput) => {
                    const after = run(input.id, "cancelled", { agentId, updatedAt: 2 });
                    mutationFixture.runs.set(input.id, after);
                    return {
                        agentId,
                        operationId: input.operationId ?? "cancel-sync",
                        run: after,
                        changed: true,
                    };
                }) as unknown as WorkflowStore["cancel"],
            },
        });
        await expect(
            synchronousMutation.cancel(ctx(), OWNER, {
                id: "run-1",
                operationId: "cancel-sync",
            }),
        ).rejects.toThrow("cancel must return a Promise");
        expect(mutationFixture.runs.get("run-1")?.status).toBe("queued");

        for (const method of ["readReceipt", "readMutationProof"] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: {
                    ...fixture.store,
                    [method]: (() => undefined) as unknown as WorkflowStore[typeof method],
                },
            });
            await expect(
                feature.launch(ctx(), OWNER, {
                    workflow: "demo",
                    operationId: `run-${method}`,
                }),
            ).rejects.toThrow(`${method} must return a Promise`);
        }

        for (const method of ["writeMutationProof", "writeReceipt"] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: {
                    ...fixture.store,
                    [method]: (() => undefined) as unknown as WorkflowStore[typeof method],
                },
            });
            await expect(
                feature.launch(ctx(), OWNER, {
                    workflow: "demo",
                    operationId: `run-${method}`,
                }),
            ).rejects.toThrow(`${method} must return a Promise`);
            expect(fixture.runs).toHaveLength(0);
        }

        const malformedProofFixture = storeFixture();
        const malformedProofFeature = new WorkflowsFeature({
            store: {
                ...malformedProofFixture.store,
                readMutationProof: async () => ({ invalid: true }) as never,
            },
        });
        await expect(
            malformedProofFeature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "malformed-proof",
            }),
        ).rejects.toThrow("invalid mutation proof");

        const malformedWriteFixture = storeFixture();
        const malformedWriteFeature = new WorkflowsFeature({
            store: {
                ...malformedWriteFixture.store,
                writeReceipt: async () => 42 as never,
            },
        });
        await expect(
            malformedWriteFeature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "malformed-write",
            }),
        ).rejects.toThrow("must resolve to undefined");
        expect(malformedWriteFixture.runs).toHaveLength(0);
    });

    it("invokes class-backed WorkflowStore methods through their owning object", async () => {
        const fixture = storeFixture();
        let ownerObserved = false;
        let classBacked!: WorkflowStore;
        const prototype = {
            get(this: unknown, _ctx: Context, agentId: string, id: string) {
                expect(this).toBe(classBacked);
                ownerObserved = true;
                return Promise.resolve(run(id, "queued", { agentId }));
            },
        };
        classBacked = Object.assign(Object.create(prototype), fixture.store) as WorkflowStore;
        delete (classBacked as Partial<WorkflowStore>).get;
        const feature = new WorkflowsFeature({ store: classBacked });

        await expect(feature.status(ctx(), OWNER, "run-1")).resolves.toMatchObject({
            id: "run-1",
            agentId: OWNER,
        });
        expect(ownerObserved).toBe(true);
    });

    it("preserves class-backed factory and clock owners and validates resolved values", async () => {
        const fixture = storeFixture();
        let options!: OwnedOptions;
        class OwnedOptions {
            readonly store = fixture.store;
            #idCalls = 0;
            #eventCalls = 0;
            #clockCalls = 0;

            idFactory(_ctx: Context, agentId: string): Promise<string> {
                expect(this).toBe(options);
                expect(agentId).toBe(OWNER);
                this.#idCalls += 1;
                return Promise.resolve(`owned-run-${this.#idCalls}`);
            }

            eventIdFactory(_ctx: Context, agentId: string): string {
                expect(this).toBe(options);
                expect(agentId).toBe(OWNER);
                this.#eventCalls += 1;
                return `owned-event-${this.#eventCalls}`;
            }

            clock(): number {
                expect(this).toBe(options);
                this.#clockCalls += 1;
                return this.#clockCalls;
            }

            counts(): readonly number[] {
                return [this.#idCalls, this.#eventCalls, this.#clockCalls];
            }
        }
        options = new OwnedOptions();
        const feature = new WorkflowsFeature(options);
        const toolCtx = withAgentKV(
            ctx(),
            new AgentKV(new InMemoryPersistence(), "owned-factory."),
        );
        await expect(
            feature.launchForTool(toolCtx, OWNER, { workflow: "demo" }),
        ).resolves.toMatchObject({ id: "owned-run-1" });
        expect(options.counts()).toEqual([1, 1, 2]);

        const badId = new WorkflowsFeature({
            store: storeFixture().store,
            idFactory: async () => 42 as never,
        });
        await expect(
            badId.launchForTool(
                withAgentKV(ctx(), new AgentKV(new InMemoryPersistence(), "bad-id.")),
                OWNER,
                { workflow: "demo" },
            ),
        ).rejects.toThrow("ID is invalid");

        const badEventFixture = storeFixture();
        const badEvent = new WorkflowsFeature({
            store: badEventFixture.store,
            eventIdFactory: async () => 42 as never,
        });
        await expect(
            badEvent.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: "bad-event-run",
            }),
        ).rejects.toThrow("event ID factory returned an invalid ID");
        expect(badEventFixture.runs).toHaveLength(0);

        expect(
            () =>
                new WorkflowsFeature({
                    store: storeFixture().store,
                    clock: (() => Promise.resolve(1)) as never,
                }),
        ).toThrow("clock");
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
        fixture.runs.set("run-1", run("run-1", "paused", { updatedAt: 3 }));
        await expect(
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" }),
        ).rejects.toThrow("substituted event");
    });

    it("rejects stalled or empty cursor pages", async () => {
        const fixture = storeFixture();
        const pageCases: Array<{ readonly page: WorkflowPage; readonly cursor?: number }> = [
            {
                page: { agentId: OWNER, cursor: 0, runs: [], totalRuns: 1, nextCursor: 1 },
            },
            {
                page: {
                    agentId: OWNER,
                    cursor: 0,
                    runs: [run("run-1")],
                    totalRuns: 2,
                    nextCursor: 0,
                },
            },
            {
                page: {
                    agentId: OWNER,
                    cursor: 0,
                    runs: [run("run-1")],
                    totalRuns: 2,
                    nextCursor: 4,
                },
            },
            {
                page: {
                    agentId: OWNER,
                    cursor: 5,
                    runs: [run("run-1")],
                    totalRuns: 10,
                    nextCursor: 4,
                    previousCursor: 0,
                },
                cursor: 5,
            },
        ];
        for (const { page, cursor } of pageCases) {
            const feature = new WorkflowsFeature({
                store: { ...fixture.store, list: async () => page },
            });
            await expect(
                feature.list(ctx(), OWNER, cursor === undefined ? {} : { cursor }),
            ).rejects.toThrow(/cursor|offset/);
        }

        const logCases: Array<{ readonly page: WorkflowLogPage; readonly cursor?: number }> = [
            {
                page: {
                    agentId: OWNER,
                    id: "run-1",
                    cursor: 0,
                    lines: [],
                    totalLines: 1,
                    nextCursor: 1,
                },
            },
            {
                page: {
                    agentId: OWNER,
                    id: "run-1",
                    cursor: 0,
                    lines: [{ position: 0, text: "line" }],
                    totalLines: 2,
                    nextCursor: 4,
                },
            },
            {
                page: {
                    agentId: OWNER,
                    id: "run-1",
                    cursor: 0,
                    lines: [{ position: 0, text: "line" }],
                    totalLines: 2,
                    nextCursor: 0,
                },
            },
            {
                page: {
                    agentId: OWNER,
                    id: "run-1",
                    cursor: 5,
                    lines: [{ position: 5, text: "line" }],
                    totalLines: 10,
                    nextCursor: 4,
                    previousCursor: 0,
                },
                cursor: 5,
            },
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
            ).rejects.toThrow(/cursor|offset/);
        }
    });

    it("supports exact forward, backward, end, and beyond-end offset pages", async () => {
        const fixture = storeFixture();
        for (const id of ["run-1", "run-2", "run-3"]) {
            fixture.runs.set(id, run(id));
        }
        const lines = ["first", "second", "third"].map((text, position) => ({
            position,
            text,
        }));
        const store: WorkflowStore = {
            ...fixture.store,
            logs: async (_ctx, agentId, query) => {
                const limit = query.limit ?? 2;
                const cursor =
                    query.from === "end"
                        ? Math.max(0, lines.length - limit)
                        : "cursor" in query
                          ? (query.cursor ?? 0)
                          : 0;
                const selected = lines.slice(cursor, cursor + limit);
                return {
                    agentId,
                    id: query.id,
                    cursor,
                    lines: selected,
                    totalLines: lines.length,
                    ...(cursor + selected.length < lines.length
                        ? { nextCursor: cursor + selected.length }
                        : {}),
                    ...(Math.min(cursor, lines.length) === 0
                        ? {}
                        : {
                              previousCursor: Math.max(0, Math.min(cursor, lines.length) - limit),
                          }),
                };
            },
        };
        const feature = new WorkflowsFeature({ store });

        const latest = await feature.list(ctx(), OWNER, { from: "end", limit: 2 });
        expect(latest).toMatchObject({
            cursor: 1,
            totalRuns: 3,
            previousCursor: 0,
            runs: [{ id: "run-2" }, { id: "run-3" }],
        });
        const first = await feature.list(ctx(), OWNER, {
            cursor: latest.previousCursor!,
            limit: 2,
        });
        expect(first).toMatchObject({
            cursor: 0,
            totalRuns: 3,
            nextCursor: 2,
            runs: [{ id: "run-1" }, { id: "run-2" }],
        });
        const beyond = await feature.list(ctx(), OWNER, {
            cursor: Number.MAX_SAFE_INTEGER,
            limit: 2,
        });
        expect(beyond).toEqual({
            agentId: OWNER,
            cursor: Number.MAX_SAFE_INTEGER,
            runs: [],
            totalRuns: 3,
            previousCursor: 1,
        });
        const latestLogs = await feature.logs(ctx(), OWNER, {
            id: "run-1",
            from: "end",
            limit: 2,
        });
        expect(latestLogs).toMatchObject({
            cursor: 1,
            totalLines: 3,
            previousCursor: 0,
            lines: [
                { position: 1, text: "second" },
                { position: 2, text: "third" },
            ],
        });
        const beyondLogs = await feature.logs(ctx(), OWNER, {
            id: "run-1",
            cursor: Number.MAX_SAFE_INTEGER,
            limit: 2,
        });
        expect(beyondLogs).toEqual({
            agentId: OWNER,
            id: "run-1",
            cursor: Number.MAX_SAFE_INTEGER,
            lines: [],
            totalLines: 3,
            previousCursor: 1,
        });

        const empty = new WorkflowsFeature({ store: storeFixture().store });
        await expect(empty.list(ctx(), OWNER, { from: "end", limit: 2 })).resolves.toEqual({
            agentId: OWNER,
            cursor: 0,
            runs: [],
            totalRuns: 0,
        });
    });

    it("rejects duplicate, unordered, filtered, or position-substituted pages", async () => {
        const fixture = storeFixture();
        for (const page of [
            {
                agentId: OWNER,
                cursor: 0,
                runs: [run("run-1"), run("run-1")],
                totalRuns: 2,
            },
            {
                agentId: OWNER,
                cursor: 0,
                runs: [run("run-2"), run("run-1")],
                totalRuns: 2,
            },
        ] satisfies WorkflowPage[]) {
            const feature = new WorkflowsFeature({
                store: { ...fixture.store, list: async () => page },
            });
            await expect(feature.list(ctx(), OWNER)).rejects.toThrow("duplicate or unordered");
        }

        const terminalFeature = new WorkflowsFeature({
            store: {
                ...fixture.store,
                list: async () => ({
                    agentId: OWNER,
                    cursor: 0,
                    runs: [run("run-1", "completed")],
                    totalRuns: 1,
                }),
            },
        });
        await expect(
            terminalFeature.list(ctx(), OWNER, { includeTerminal: false }),
        ).rejects.toThrow("terminal run");

        for (const page of [
            {
                agentId: OWNER,
                id: "run-1",
                cursor: 0,
                lines: [{ position: 1, text: "skipped" }],
                totalLines: 1,
            },
            {
                agentId: OWNER,
                id: "run-1",
                cursor: 0,
                lines: [
                    { position: 0, text: "first" },
                    { position: 0, text: "duplicate" },
                ],
                totalLines: 2,
            },
        ] satisfies WorkflowLogPage[]) {
            const feature = new WorkflowsFeature({
                store: { ...fixture.store, logs: async () => page },
            });
            await expect(feature.logs(ctx(), OWNER, { id: "run-1" })).rejects.toThrow(
                "log positions",
            );
        }

        const beyondEnd = new WorkflowsFeature({
            store: {
                ...fixture.store,
                list: async () => ({
                    agentId: OWNER,
                    cursor: 100,
                    runs: [],
                    totalRuns: 2,
                    previousCursor: 0,
                }),
                logs: async () => ({
                    agentId: OWNER,
                    id: "run-1",
                    cursor: 100,
                    lines: [],
                    totalLines: 2,
                    previousCursor: 0,
                }),
            },
        });
        await expect(beyondEnd.list(ctx(), OWNER, { cursor: 100 })).resolves.toEqual({
            agentId: OWNER,
            cursor: 100,
            runs: [],
            totalRuns: 2,
            previousCursor: 0,
        });
        await expect(beyondEnd.logs(ctx(), OWNER, { id: "run-1", cursor: 100 })).resolves.toEqual({
            agentId: OWNER,
            id: "run-1",
            cursor: 100,
            lines: [],
            totalLines: 2,
            previousCursor: 0,
        });
    });

    it("enforces paused resume and terminal cancellation semantics without host rewrites", async () => {
        const fixture = storeFixture();
        const feature = new WorkflowsFeature({
            store: fixture.store,
            eventIdFactory: () => `event-${fixture.events.length + 1}`,
            clock: () => 10,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    fixture.events.push(event);
                },
            },
        });

        fixture.runs.set("paused", run("paused", "paused"));
        const resumed = await feature.resume(ctx(), OWNER, {
            id: "paused",
            operationId: "resume-paused",
        });
        expect(resumed).toMatchObject({ changed: true, run: { status: "running" } });

        const callsAfterResume = fixture.mutationCalls.length;
        const runningNoOp = await feature.resume(ctx(), OWNER, {
            id: "paused",
            operationId: "resume-running",
        });
        expect(runningNoOp).toMatchObject({ changed: false, run: { status: "running" } });
        expect(fixture.mutationCalls).toHaveLength(callsAfterResume);

        for (const status of [
            "queued",
            "completed",
            "failed",
            "cancelled",
            "unavailable",
        ] as const) {
            const id = `resume-${status}`;
            fixture.runs.set(id, run(id, status));
            await expect(
                feature.resume(ctx(), OWNER, {
                    id,
                    operationId: `invalid-${status}`,
                }),
            ).rejects.toThrow("Only a paused workflow run");
        }
        expect(fixture.mutationCalls).toHaveLength(callsAfterResume);

        for (const status of ["completed", "failed", "cancelled", "unavailable"] as const) {
            const id = `cancel-${status}`;
            const terminal = run(id, status);
            fixture.runs.set(id, terminal);
            const callsBefore = fixture.mutationCalls.length;
            const eventsBefore = fixture.events.length;
            const result = await feature.cancel(ctx(), OWNER, {
                id,
                operationId: `cancel-terminal-${status}`,
            });
            expect(result).toEqual({
                agentId: OWNER,
                operationId: `cancel-terminal-${status}`,
                run: terminal,
                changed: false,
            });
            expect(fixture.runs.get(id)).toEqual(terminal);
            expect(fixture.mutationCalls).toHaveLength(callsBefore);
            expect(fixture.events).toHaveLength(eventsBefore);
        }

        for (const status of ["queued", "running", "paused"] as const) {
            const id = `cancel-${status}`;
            fixture.runs.set(id, run(id, status));
            const result = await feature.cancel(ctx(), OWNER, {
                id,
                operationId: `cancel-active-${status}`,
            });
            expect(result).toMatchObject({ changed: true, run: { status: "cancelled" } });
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
        ).rejects.toThrow("cancelled run");

        fixture.runs.set("run-1", run("run-1", "paused"));
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
        ).rejects.toThrow(/running run|authoritative|fields/);
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
        expect(Value.Check(workflowCallOperationSchema, receipt)).toBe(true);
        expect(receipt).toMatchObject({
            operationId: "run-1",
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
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
            fixture.runs.set("run-1", run("run-1", operation === "cancel" ? "queued" : "paused"));
            fixture.runs.set("run-2", run("run-2", operation === "cancel" ? "queued" : "paused"));
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
                operation === "cancel" ? "queued" : "paused",
            );
            const receipt = await new AgentKV(persistence, `workflow-${operation}-receipt.`).read(
                ctx(),
                `workflow_${operation}_operation_id:agent-1`,
            );
            expect(Value.Check(workflowCallOperationSchema, receipt)).toBe(true);

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
        ).rejects.toThrow("call operation is invalid");
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

    it("replays cancellation after later state without a duplicate event", async () => {
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
        const stopped = await feature.cancelForTool(stopCtx, OWNER, { id: "run-1" });
        fixture.runs.set("run-1", run("run-1", "running", { startedAt: 1, updatedAt: 3 }));
        const replayed = await feature.cancelForTool(stopCtx, OWNER, { id: "run-1" });

        expect(stopped.run.status).toBe("cancelled");
        expect(replayed).toEqual({
            agentId: OWNER,
            operationId: stopped.operationId,
            run: stopped.run,
            changed: true,
        });
        expect(fixture.runs.get("run-1")?.status).toBe("running");
        expect(idsAllocated).toBe(1);
        expect(fixture.events).toHaveLength(2);
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
        fixture.runs.set("run-1", run("run-1", "paused", { updatedAt: 3 }));
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
            changed: true,
        });
        expect(fixture.mutationCalls.map(({ operationId }) => operationId)).toEqual([
            "operation-a",
            "operation-b",
            "operation-c",
        ]);
        expect(fixture.events).toHaveLength(4);

        await expect(
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "operation-a" }),
        ).rejects.toThrow("another operation");
        await expect(
            feature.cancel(ctx(), OWNER, { id: "other-run", operationId: "operation-a" }),
        ).rejects.toThrow("does not match");
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
        fixture.runs.set("run-1", run("run-1", "paused", { updatedAt: 2 }));
        const [resumed, cancelled] = await Promise.all([
            feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" }),
            feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" }),
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
            cursor: MAX_WORKFLOW_CURSOR - 1,
            runs: [maximum],
            totalRuns: MAX_WORKFLOW_CURSOR,
            previousCursor: MAX_WORKFLOW_CURSOR - 2,
            nextCursor: MAX_WORKFLOW_CURSOR,
        });
        expect(pageText.startsWith(id)).toBe(true);
        expect(pageText).toContain(workflow);
        expect(pageText.length).toBeLessThanOrEqual(256);
        const logText = feature.formatLogsForModel({
            agentId: OWNER,
            id,
            cursor: MAX_WORKFLOW_CURSOR - 1,
            lines: [{ position: MAX_WORKFLOW_CURSOR - 1, text: "x".repeat(4_000) }],
            totalLines: MAX_WORKFLOW_CURSOR,
            previousCursor: MAX_WORKFLOW_CURSOR - 2,
            nextCursor: MAX_WORKFLOW_CURSOR,
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
                .find((tool) => tool.name === "cancel_workflow")?.returnType,
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
        await expect(feature.list(ctx(), OWNER, { limit: 2 })).rejects.toThrow("exceeds");
        const logs = await feature.logs(ctx(), OWNER, { id: "run-1", limit: 1 });
        expect(logs.lines).toEqual([{ position: 0, text: "hello" }]);
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

    it("preserves listener owners and enforces void or Promise<void> results", async () => {
        const ownedFixture = storeFixture();
        let listener!: OwnedListener;
        class OwnedListener {
            readonly #events: WorkflowEvent[] = [];

            onEventTransactional(_ctx: Context, event: WorkflowEvent): void {
                expect(this).toBe(listener);
                this.#events.push(event);
            }

            async onEvent(_ctx: Context, event: WorkflowEvent): Promise<void> {
                expect(this).toBe(listener);
                this.#events.push(event);
            }

            events(): readonly WorkflowEvent[] {
                return this.#events;
            }
        }
        listener = new OwnedListener();
        const owned = new WorkflowsFeature({
            store: ownedFixture.store,
            listener,
            eventIdFactory: () => "owned-listener-event",
            clock: () => 1,
        });
        await owned.launch(ctx(), OWNER, {
            workflow: "demo",
            operationId: "owned-listener-run",
        });
        await ownedFixture.callbacks[0]!(ctx());
        expect(listener.events()).toHaveLength(2);
        expect(listener.events()[0]).toBe(listener.events()[1]);

        for (const [label, callback] of [
            ["synchronous", () => 42],
            ["asynchronous", () => Promise.resolve(42)],
        ] as const) {
            const fixture = storeFixture();
            const feature = new WorkflowsFeature({
                store: fixture.store,
                listener: {
                    onEventTransactional: callback as never,
                },
            });
            await expect(
                feature.launch(ctx(), OWNER, {
                    workflow: "demo",
                    operationId: `${label}-transactional`,
                }),
            ).rejects.toThrow(/undefined|resolve/);
            expect(fixture.runs).toHaveLength(0);
            expect(fixture.callbacks).toHaveLength(0);
        }

        for (const [label, callback] of [
            ["synchronous", () => 42],
            ["asynchronous", () => Promise.resolve(42)],
        ] as const) {
            const fixture = storeFixture();
            const reports: string[] = [];
            const feature = new WorkflowsFeature({
                store: fixture.store,
                listener: {
                    onEvent: callback as never,
                },
                onPostCommitError: (_ctx, _event, error) => {
                    reports.push(error);
                },
            });
            await feature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: `${label}-post-commit`,
            });
            await expect(fixture.callbacks[0]!(ctx())).resolves.toBeUndefined();
            expect(fixture.runs).toHaveLength(1);
            expect(reports).toHaveLength(1);
            expect(reports[0]).toMatch(/undefined|resolve/);
        }
    });

    it("normalizes hostile post-commit failures and preserves reporter ownership", async () => {
        const hostile = Object.create(null, {
            message: {
                get() {
                    throw new Error("message getter failed");
                },
            },
            toString: {
                value() {
                    throw new Error("conversion failed");
                },
            },
        });
        const cases = [Object.create(null), hostile, { message: `${"x".repeat(1_000)}\0` }];
        const reports: string[] = [];

        for (const [index, thrown] of cases.entries()) {
            const fixture = storeFixture();
            const errors: string[] = [];
            class ReporterOptions {
                readonly store = fixture.store;
                readonly listener = {
                    onEvent() {
                        throw thrown;
                    },
                };
                readonly idFactory = () => `run-${index}`;
                readonly eventIdFactory = () => `event-${index}`;
                readonly clock = () => 1;
                readonly #errors: string[];

                constructor(reported: string[]) {
                    this.#errors = reported;
                }

                onPostCommitError(_ctx: Context, _event: WorkflowEvent, error: string): void {
                    this.#errors.push(error);
                    throw new Error("reporter failed");
                }
            }
            const options = new ReporterOptions(errors);
            const feature = new WorkflowsFeature(options);
            await feature.launch(ctx(), OWNER, {
                workflow: "demo",
                operationId: `run-${index}`,
            });
            await expect(fixture.callbacks[0]!(ctx())).resolves.toBeUndefined();
            expect(errors).toHaveLength(1);
            expect(Value.Check(workflowPostCommitErrorSchema, errors[0])).toBe(true);
            expect(errors[0]).not.toContain("\0");
            reports.push(errors[0]!);
        }
        expect(reports[0]).toBe("Unknown Workflow observer error.");
        expect(reports[1]).toBe("Unknown Workflow observer error.");
        expect(reports[2]).toHaveLength(MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH);
        expect(reports[2]?.endsWith("…")).toBe(true);
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
        expect((await feature.status(ctx(), OWNER, "run-1"))?.status).toBe("queued");
        expect(
            (await feature.cancel(ctx(), OWNER, { id: "run-1", operationId: "cancel-1" })).run
                .status,
        ).toBe("cancelled");
        fixture.runs.set("run-1", run("run-1", "paused", { updatedAt: 3 }));
        expect(
            (await feature.resume(ctx(), OWNER, { id: "run-1", operationId: "resume-1" })).run
                .status,
        ).toBe("running");
        fixture.runs.set("run-1", run("run-1", "completed", { updatedAt: 3 }));
        expect((await feature.wait(ctx(), OWNER, "run-1")).id).toBe("run-1");
    });
});
