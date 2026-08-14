import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_USAGE_PAGE_SIZE,
    usageAggregateQuerySchema,
    usagePageSchema,
    usageRecordSchema,
    usageSummarySchema,
    type UsagePage,
    type UsageRecord,
    type UsageSummary,
} from "../../sources/usage/Usage.js";
import { UsageFeature, usageFeatureOptionsSchema } from "../../sources/usage/UsageFeature.js";
import { UsageFeature as RootUsageFeature } from "../../sources/index.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import type {
    UsageRecordStoreResult,
    UsageResetStoreResult,
    UsageStore,
} from "../../sources/usage/UsageStore.js";
import type { UsageResetReceipt } from "../../sources/usage/Usage.js";

const ctx = createRootContext().named("usage-feature-test");

interface PendingCallback {
    readonly callback: (ctx: Context) => void | Promise<void>;
}

class FakeKV {
    readonly values = new Map<string, unknown>();
    failDelete = false;

    async read(_ctx: Context, key: string): Promise<unknown> {
        return structuredClone(this.values.get(key));
    }

    async write(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, structuredClone(value));
    }

    async delete(_ctx: Context, key: string): Promise<void> {
        if (this.failDelete) {
            this.failDelete = false;
            throw new Error("delete unavailable");
        }
        this.values.delete(key);
    }
}

class MemoryUsageStore {
    readonly records = new Map<string, UsageRecord>();
    readonly resetReceipts = new Map<string, UsageResetReceipt>();
    readonly resetCalls: string[] = [];
    readonly events: UsageEvent[] = [];
    readonly callbacks: PendingCallback[] = [];
    readonly postCommitContext = createRootContext().named("usage-post-commit");
    readonly contract: UsageStore = {
        transaction: this.transaction.bind(this),
        afterCommit: this.afterCommit.bind(this),
        record: this.record.bind(this),
        read: this.read.bind(this),
        aggregate: this.aggregate.bind(this),
        reset: this.reset.bind(this),
        readResetReceipt: this.readResetReceipt.bind(this),
        writeResetReceipt: this.writeResetReceipt.bind(this),
    };
    #depth = 0;
    #transactionTail: Promise<void> = Promise.resolve();
    #snapshot: Map<string, UsageRecord> | undefined;
    #receiptSnapshot: Map<string, UsageResetReceipt> | undefined;

    async transaction<Result>(
        _ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const previous = this.#transactionTail;
        let release!: () => void;
        const turn = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#transactionTail = previous.then(() => turn);
        await previous;
        try {
            const outermost = this.#depth === 0;
            if (outermost) {
                this.#snapshot = new Map(this.records);
                this.#receiptSnapshot = new Map(this.resetReceipts);
            }
            this.#depth++;
            try {
                const result = await work(ctx);
                this.#depth--;
                if (outermost) {
                    this.#snapshot = undefined;
                    while (this.callbacks.length > 0) {
                        await this.callbacks.shift()!.callback(this.postCommitContext);
                    }
                    this.#receiptSnapshot = undefined;
                }
                return result;
            } catch (error: unknown) {
                this.#depth--;
                if (outermost) {
                    this.records.clear();
                    for (const [id, record] of this.#snapshot ?? []) {
                        this.records.set(id, record);
                    }
                    this.resetReceipts.clear();
                    for (const [id, receipt] of this.#receiptSnapshot ?? []) {
                        this.resetReceipts.set(id, receipt);
                    }
                    this.callbacks.length = 0;
                    this.#snapshot = undefined;
                    this.#receiptSnapshot = undefined;
                }
                throw error;
            }
        } finally {
            release();
        }
    }

    afterCommit(_ctx: Context, callback: (postCommitCtx: Context) => void | Promise<void>): void {
        if (this.#depth === 0) throw new Error("outside transaction");
        this.callbacks.push({ callback });
    }

    async record(_ctx: Context, record: UsageRecord): Promise<UsageRecordStoreResult> {
        const existing = this.records.get(record.id);
        if (existing !== undefined) {
            expect(existing).toEqual(record);
            return {
                operationId: record.id,
                agentId: record.agentId,
                recordId: record.id,
                inserted: false,
                record: structuredClone(existing),
            };
        }
        this.records.set(record.id, structuredClone(record));
        return {
            operationId: record.id,
            agentId: record.agentId,
            recordId: record.id,
            inserted: true,
            record: structuredClone(record),
        };
    }

    async read(
        _ctx: Context,
        agentId: string,
        query: { readonly cursor?: number; readonly limit?: number },
    ): Promise<UsagePage> {
        const limit = query.limit ?? 50;
        const records = [...this.records.values()]
            .filter((record) => record.agentId === agentId)
            .sort((left, right) => left.finishedAt - right.finishedAt);
        const cursor = query.cursor ?? 0;
        const page = {
            agentId,
            records: records.slice(cursor, cursor + limit),
            cursor,
            totalRecords: records.length,
            ...(cursor + limit < records.length ? { nextCursor: cursor + limit } : {}),
        };
        if (!Value.Check(usagePageSchema, page)) throw new Error("bad test page");
        return page;
    }

    async aggregate(
        _ctx: Context,
        query: {
            readonly agentId?: string;
            readonly cursor?: number;
            readonly maxGroups?: number;
        },
    ): Promise<UsageSummary> {
        const records = [...this.records.values()].filter(
            (record) => query.agentId === undefined || record.agentId === query.agentId,
        );
        const groups = new Map<string, UsageSummary["groups"][number]>();
        const summary: UsageSummary = {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            cursor: query.cursor ?? 0,
            totalGroups: 0,
            inferenceCount: 0,
            turnCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inferenceDurationMs: 0,
            turnDurationMs: 0,
            totalDurationMs: 0,
            groups: [],
        };
        for (const record of records) {
            const key = JSON.stringify([record.provider, record.model, record.effort, record.tier]);
            const previous =
                groups.get(key) ??
                ({
                    provider: record.provider,
                    ...(record.model === undefined ? {} : { model: record.model }),
                    ...(record.effort === undefined ? {} : { effort: record.effort }),
                    ...(record.tier === undefined ? {} : { tier: record.tier }),
                    inferenceCount: 0,
                    turnCount: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    inferenceDurationMs: 0,
                    turnDurationMs: 0,
                    totalDurationMs: 0,
                } as UsageSummary["groups"][number]);
            if (record.kind === "inference") {
                summary.inferenceCount++;
                summary.inputTokens += record.tokens.input;
                summary.outputTokens += record.tokens.output;
                summary.totalTokens += record.tokens.input + record.tokens.output;
                summary.inferenceDurationMs += record.durationMs;
                previous.inferenceCount++;
                previous.inputTokens += record.tokens.input;
                previous.outputTokens += record.tokens.output;
                previous.totalTokens += record.tokens.input + record.tokens.output;
                previous.inferenceDurationMs += record.durationMs;
            } else {
                summary.turnCount++;
                summary.turnDurationMs += record.durationMs;
                previous.turnCount++;
                previous.turnDurationMs += record.durationMs;
            }
            summary.totalDurationMs = summary.inferenceDurationMs + summary.turnDurationMs;
            previous.totalDurationMs = previous.inferenceDurationMs + previous.turnDurationMs;
            groups.set(key, previous);
        }
        const maxGroups = query.maxGroups ?? 100;
        const allGroups = [...groups.values()];
        summary.totalGroups = allGroups.length;
        const cursor = query.cursor ?? 0;
        summary.groups = allGroups.slice(cursor, cursor + maxGroups);
        if (cursor + maxGroups < allGroups.length) {
            summary.nextCursor = cursor + maxGroups;
        }
        if (!Value.Check(usageSummarySchema, summary)) throw new Error("bad test summary");
        return summary;
    }

    async reset(
        _ctx: Context,
        agentId: string | undefined,
        operationId: string,
    ): Promise<UsageResetStoreResult> {
        this.resetCalls.push(operationId);
        const ids = [...this.records.values()]
            .filter((record) => agentId === undefined || record.agentId === agentId)
            .map((record) => record.id);
        for (const id of ids) this.records.delete(id);
        return {
            operationId,
            agentId: agentId ?? null,
            removed: ids.length,
        };
    }

    async readResetReceipt(
        _ctx: Context,
        operationId: string,
    ): Promise<UsageResetReceipt | undefined> {
        const receipt = this.resetReceipts.get(operationId);
        return receipt === undefined ? undefined : structuredClone(receipt);
    }

    async writeResetReceipt(
        _ctx: Context,
        receipt: UsageResetReceipt,
        options: { readonly maxReceipts: number },
    ): Promise<{ readonly retained: number }> {
        this.resetReceipts.set(receipt.operationId, structuredClone(receipt));
        while (this.resetReceipts.size > options.maxReceipts) {
            const oldest = this.resetReceipts.keys().next().value;
            if (oldest === undefined) break;
            this.resetReceipts.delete(oldest);
        }
        return { retained: this.resetReceipts.size };
    }
}

function scope(runKV: FakeKV, agentId = "agent-1") {
    return {
        agent: {
            id: agentId,
            provider: "provider-main",
            providerKind: "codex" as const,
            model: "model-main",
            effort: "high" as const,
            tier: "priority" as const,
            permissionMode: "auto" as const,
        },
        kv: undefined,
        sharedKV: undefined,
        runKV,
    } as never;
}

function makeFeature(
    store: MemoryUsageStore,
    clock: () => number,
    listener?: {
        onEventTransactional?: (ctx: Context, event: UsageEvent) => void | Promise<void>;
        onEvent?: (ctx: Context, event: UsageEvent) => void | Promise<void>;
    },
) {
    let nextId = 0;
    return new UsageFeature({
        store: store.contract,
        clock,
        ...(listener === undefined ? {} : { listener }),
        idFactory: (_ctx, agentId, kind) => `${kind}-${agentId}-${nextId++}`,
    });
}

describe("UsageFeature", () => {
    it("exports the same UsageFeature identity through the package root", () => {
        expect(RootUsageFeature).toBe(UsageFeature);
    });

    it("records provider attribution, tokens, timing, and turns through the store", async () => {
        const store = new MemoryUsageStore();
        let now = 100;
        const feature = makeFeature(store, () => now);
        const runKV = new FakeKV();
        const agentScope = scope(runKV);

        await feature.beforeTurnTransact!(ctx, agentScope);
        now = 125;
        await feature.beforeInferenceTransact!(ctx, agentScope);
        now = 150;
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 10, output: 4 },
        });
        now = 175;
        await feature.afterTurn!(ctx, agentScope, {
            contextTokens: 14,
            aborted: false,
        });

        expect(store.records).toHaveLength(2);
        const records = [...store.records.values()];
        expect(records[0]).toMatchObject({
            kind: "inference",
            provider: "provider-main",
            model: "model-main",
            effort: "high",
            tier: "priority",
            tokens: { input: 10, output: 4 },
            startedAt: 125,
            finishedAt: 150,
            durationMs: 25,
        });
        expect(records[1]).toMatchObject({
            kind: "turn",
            contextTokens: 14,
            startedAt: 100,
            finishedAt: 175,
            durationMs: 75,
        });
        const summary = await feature.read(ctx, "agent-1");
        expect(summary).toMatchObject({
            inferenceCount: 1,
            turnCount: 1,
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            inferenceDurationMs: 25,
            turnDurationMs: 75,
        });
    });

    it("uses stable run identities when cleanup is interrupted", async () => {
        const store = new MemoryUsageStore();
        let now = 100;
        const feature = makeFeature(store, () => now);
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        now = 120;
        runKV.failDelete = true;
        await feature.afterInference!(ctx, agentScope, {
            state: "tool_call",
            tokens: { input: 1, output: 2 },
        });
        const first = [...store.records.values()][0]!;
        now = 130;
        await feature.afterInference!(ctx, agentScope, {
            state: "tool_call",
            tokens: { input: 1, output: 2 },
        });
        expect(store.records).toHaveLength(1);
        expect([...store.records.values()][0]?.id).toBe(first.id);
    });

    it("contains store and optional observer failures", async () => {
        const store = new MemoryUsageStore();
        const errors: string[] = [];
        const feature = new UsageFeature({
            store: {
                ...store.contract,
                transaction: async () => {
                    throw new Error("store down");
                },
            },
            onObserverError: (_ctx, phase, message) => {
                errors.push(`${phase}:${message}`);
            },
        });
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await expect(
            feature.afterInference!(ctx, agentScope, {
                state: "error",
                errorMessage: "failed",
                tokens: { input: 1, output: 0 },
            }),
        ).resolves.toBeUndefined();
        expect(errors.some((error) => error.includes("store down"))).toBe(true);
    });

    it("validates bounded store pages and protects model-facing output", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 3, output: 2 },
        });
        expect(Value.Check(usageRecordSchema, [...store.records.values()][0])).toBe(true);
        const page = await feature.readPage(ctx, "agent-1", { limit: 1 });
        expect(page.records).toHaveLength(1);
        expect(page.records.length).toBeLessThanOrEqual(MAX_USAGE_PAGE_SIZE);
        expect(feature.formatForModel(await feature.read(ctx, "agent-1"))).toContain(
            "provider-main/model-main",
        );
        await expect(feature.readPage(ctx, "agent-1", { limit: 101 })).rejects.toThrow("invalid");
        expect(Value.Check(usagePageSchema, page)).toBe(true);
    });

    it("emits one stable transactional and outermost post-commit event per mutation", async () => {
        const store = new MemoryUsageStore();
        const events: string[] = [];
        const feature = makeFeature(store, () => 100, {
            onEventTransactional: (_ctx, event) => {
                events.push(`tx:${event.eventId}`);
            },
            onEvent: (_ctx, event) => {
                events.push(`post:${event.eventId}`);
            },
        });
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(events).toHaveLength(2);
        expect(events[0]?.replace("tx:", "")).toBe(events[1]?.replace("post:", ""));
    });

    it("offers the common get_usage tool through the same public read path", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 7, output: 8 },
        });
        const tool = feature.tools(ctx, agentScope)[0]!;
        expect(tool.name).toBe("get_usage");
        expect(tool.durable).toBe(true);
        expect(await tool.execute(ctx, {})).toMatchObject({ totalTokens: 15 });
        expect(tool.toLLM(await tool.execute(ctx, {}))[0]?.type).toBe("text");
    });

    it("resets one agent and the collection through transactional store calls", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const runKV = new FakeKV();
        const firstScope = scope(runKV, "agent-1");
        const secondScope = scope(new FakeKV(), "agent-2");
        await feature.beforeInferenceTransact!(ctx, firstScope);
        await feature.afterInference!(ctx, firstScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        await feature.beforeInferenceTransact!(ctx, secondScope);
        await feature.afterInference!(ctx, secondScope, {
            state: "normal",
            tokens: { input: 2, output: 2 },
        });
        expect(await feature.reset(ctx, "agent-1")).toBe(1);
        expect(store.records).toHaveLength(1);
        expect(await feature.resetAll(ctx)).toBe(1);
        expect(store.records).toHaveLength(0);
    });

    it("allocates a fresh generated reset identity for each public mutation", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const firstScope = scope(new FakeKV());
        await feature.beforeInferenceTransact!(ctx, firstScope);
        await feature.afterInference!(ctx, firstScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(await feature.reset(ctx, "agent-1")).toBe(1);

        const secondScope = scope(new FakeKV());
        await feature.beforeInferenceTransact!(ctx, secondScope);
        await feature.afterInference!(ctx, secondScope, {
            state: "normal",
            tokens: { input: 2, output: 2 },
        });
        expect(await feature.reset(ctx, "agent-1")).toBe(1);

        expect(store.records).toHaveLength(0);
        expect([...store.resetReceipts.keys()]).toHaveLength(2);
    });

    it("exports a closed TypeBox options contract", () => {
        expect(
            Value.Check(usageFeatureOptionsSchema, {
                store: new MemoryUsageStore().contract,
                unexpected: true,
            }),
        ).toBe(false);
    });

    it("rolls back durable records when a transactional listener fails", async () => {
        const store = new MemoryUsageStore();
        const errors: string[] = [];
        const feature = new UsageFeature({
            store: store.contract,
            clock: () => 100,
            idFactory: () => "inference-rollback",
            listener: {
                onEventTransactional: () => {
                    throw new Error("projection failed");
                },
            },
            onObserverError: (_ctx, phase, message) => {
                errors.push(`${phase}:${message}`);
            },
        });
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(store.records).toHaveLength(0);
        expect(store.callbacks).toHaveLength(0);
        expect(errors.some((entry) => entry.includes("projection failed"))).toBe(true);
    });

    it("contains post-commit listener failure after the store commits", async () => {
        const store = new MemoryUsageStore();
        const errors: string[] = [];
        const feature = new UsageFeature({
            store: store.contract,
            clock: () => 100,
            idFactory: () => "inference-post-failure",
            listener: {
                onEvent: () => {
                    throw new Error("live projection failed");
                },
            },
            onObserverError: (_ctx, phase, message) => {
                errors.push(`${phase}:${message}`);
            },
        });
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(store.records).toHaveLength(1);
        expect(errors.some((entry) => entry.includes("live projection failed"))).toBe(true);
    });

    it("delivers one detached frozen event to both listener phases", async () => {
        const store = new MemoryUsageStore();
        const observed: UsageEvent[] = [];
        const feature = makeFeature(store, () => 100, {
            onEventTransactional: (_ctx, event) => {
                observed.push(event);
            },
            onEvent: (_ctx, event) => {
                observed.push(event);
            },
        });
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(observed).toHaveLength(2);
        expect(observed[0]).toBe(observed[1]);
        expect(Object.isFrozen(observed[0])).toBe(true);
        const firstEvent = observed[0];
        if (firstEvent?.type === "usage_recorded") {
            expect(Object.isFrozen(firstEvent.record)).toBe(true);
            expect(
                Object.isFrozen(
                    "tokens" in firstEvent.record ? firstEvent.record.tokens : undefined,
                ),
            ).toBe(true);
        }
    });

    it("replays a reset receipt without deleting records created after the first attempt", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const firstScope = scope(new FakeKV());
        await feature.beforeInferenceTransact!(ctx, firstScope);
        await feature.afterInference!(ctx, firstScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        expect(await feature.reset(ctx, "agent-1", { operationId: "reset-once" })).toBe(1);

        const secondScope = scope(new FakeKV());
        await feature.beforeInferenceTransact!(ctx, secondScope);
        await feature.afterInference!(ctx, secondScope, {
            state: "normal",
            tokens: { input: 2, output: 2 },
        });
        expect(await feature.reset(ctx, "agent-1", { operationId: "reset-once" })).toBe(1);
        expect(store.records).toHaveLength(1);
        const remaining = [...store.records.values()][0];
        expect(remaining?.kind).toBe("inference");
        if (remaining !== undefined && "tokens" in remaining) {
            expect(remaining.tokens).toEqual({ input: 2, output: 2 });
        }
    });

    it("rejects a schema-valid reset receipt whose integrity fingerprint is stale", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const firstScope = scope(new FakeKV());
        await feature.beforeInferenceTransact!(ctx, firstScope);
        await feature.afterInference!(ctx, firstScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        await feature.reset(ctx, "agent-1", { operationId: "reset-corrupt" });

        const receipt = store.resetReceipts.get("reset-corrupt");
        expect(receipt).toBeDefined();
        store.resetReceipts.set("reset-corrupt", {
            ...receipt!,
            removed: receipt!.removed + 1,
        });

        await expect(
            feature.reset(ctx, "agent-1", { operationId: "reset-corrupt" }),
        ).rejects.toThrow("integrity");
    });

    it("requires reset receipt retention and exact write read-back", async () => {
        const store = new MemoryUsageStore();
        const feature = new UsageFeature({
            store: {
                ...store.contract,
                writeResetReceipt: async (writeCtx, receipt, options) => {
                    const result = await store.writeResetReceipt(writeCtx, receipt, options);
                    store.resetReceipts.set(receipt.operationId, {
                        ...receipt,
                        fingerprint: "corrupted",
                    });
                    return result;
                },
            },
            clock: () => 100,
            idFactory: () => "reset-read-back",
        });

        await expect(
            feature.reset(ctx, "agent-1", { operationId: "reset-read-back" }),
        ).rejects.toThrow("integrity");
        expect(store.resetReceipts).toHaveLength(0);

        const noRetentionStore = new MemoryUsageStore();
        const noRetentionFeature = new UsageFeature({
            store: {
                ...noRetentionStore.contract,
                writeResetReceipt: async () => ({ retained: 0 }),
            },
            clock: () => 100,
            idFactory: () => "reset-no-retention",
        });
        await expect(
            noRetentionFeature.reset(ctx, "agent-1", { operationId: "reset-no-retention" }),
        ).rejects.toThrow("invalid result");
    });

    it("serializes concurrent retries of one reset operation", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const runKV = new FakeKV();
        await feature.beforeInferenceTransact!(ctx, scope(runKV));
        await feature.afterInference!(ctx, scope(runKV), {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });

        const results = await Promise.all([
            feature.reset(ctx, "agent-1", { operationId: "reset-concurrent" }),
            feature.reset(ctx, "agent-1", { operationId: "reset-concurrent" }),
        ]);

        expect(results).toEqual([1, 1]);
        expect(store.resetCalls).toEqual(["reset-concurrent"]);
        expect(store.records).toHaveLength(0);
        expect(store.resetReceipts).toHaveLength(1);
    });

    it("bounds durable reset receipt retention at the store boundary", async () => {
        const store = new MemoryUsageStore();
        let nextId = 0;
        const feature = new UsageFeature({
            store: store.contract,
            clock: () => 100,
            maxResetReceipts: 2,
            idFactory: (_ctx, _agentId, kind) => `${kind}-${nextId++}`,
        });

        await feature.reset(ctx, "agent-1");
        await feature.reset(ctx, "agent-1");
        await feature.reset(ctx, "agent-1");

        expect(store.resetReceipts.size).toBe(2);
    });

    it("preserves class-backed listener ownership for both event phases", async () => {
        class Listener {
            transactionalCalls = 0;
            postCommitCalls = 0;

            onEventTransactional(_ctx: Context, _event: UsageEvent): void {
                this.transactionalCalls++;
            }

            onEvent(_ctx: Context, _event: UsageEvent): void {
                this.postCommitCalls++;
            }
        }

        const store = new MemoryUsageStore();
        const listener = new Listener();
        const feature = makeFeature(store, () => 100, listener);
        const runKV = new FakeKV();
        const agentScope = scope(runKV);
        await feature.beforeInferenceTransact!(ctx, agentScope);
        await feature.afterInference!(ctx, agentScope, {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });

        expect(listener.transactionalCalls).toBe(1);
        expect(listener.postCommitCalls).toBe(1);
    });

    it("contains observer errors even when the thrown value cannot be stringified", async () => {
        const hostile = Object.create(null) as object;
        Object.defineProperty(hostile, "message", {
            get: () => {
                throw new Error("message getter failed");
            },
        });
        Object.defineProperty(hostile, Symbol.toPrimitive, {
            value: () => {
                throw new Error("string conversion failed");
            },
        });
        const store = new MemoryUsageStore();
        const errors: string[] = [];
        const feature = new UsageFeature({
            store: {
                ...store.contract,
                transaction: async () => {
                    throw hostile;
                },
            },
            onObserverError: (_ctx, _phase, message) => {
                errors.push(message);
            },
        });

        const runKV = new FakeKV();
        await feature.afterInference!(ctx, scope(runKV), {
            state: "error",
            tokens: { input: 1, output: 0 },
        });

        expect(errors).toEqual(["Unknown usage observer error."]);
    });

    it("rejects a malformed aggregate cursor and keeps model output reachable", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const first = await feature.aggregate(ctx, { agentId: "agent-1" });
        const malformed = {
            ...first,
            totalGroups: 1,
            groups: [],
            nextCursor: 0,
        };
        const malformedFeature = new UsageFeature({
            store: {
                ...store.contract,
                aggregate: async () => malformed,
            },
            clock: () => 100,
            idFactory: () => "fixed-id",
        });
        expect(Value.Check(usageAggregateQuerySchema, { cursor: 0, maxGroups: 1 })).toBe(true);
        await expect(
            malformedFeature.aggregate(ctx, { agentId: "agent-1", maxGroups: 1 }),
        ).rejects.toThrow("non-progressing");
        const modelOutput = malformedFeature.formatForModel(
            {
                ...first,
                totalGroups: 1,
                groups: [
                    {
                        provider: "provider-main",
                        model: "model-main",
                        inferenceCount: 1,
                        turnCount: 0,
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        inferenceDurationMs: 1,
                        turnDurationMs: 0,
                        totalDurationMs: 1,
                    },
                ],
                nextCursor: 1,
            },
            256,
        );
        expect(modelOutput).toContain("provider-main");
        expect(modelOutput).toContain("cursor=1");
    });

    it("keeps a complete compact identity visible for maximum-length attribution", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const longGroup: UsageSummary["groups"][number] = {
            provider: "p".repeat(256),
            model: "m".repeat(512),
            effort: "high",
            tier: "priority",
            inferenceCount: 1,
            turnCount: 0,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inferenceDurationMs: 1,
            turnDurationMs: 0,
            totalDurationMs: 1,
        };
        const output = feature.formatForModel(
            {
                agentId: "agent-1",
                cursor: 0,
                totalGroups: 2,
                inferenceCount: 2,
                turnCount: 0,
                inputTokens: 2,
                outputTokens: 2,
                totalTokens: 4,
                inferenceDurationMs: 2,
                turnDurationMs: 0,
                totalDurationMs: 2,
                groups: [longGroup, { ...longGroup, provider: "second-provider" }],
                nextCursor: 2,
            },
            256,
        );

        expect(output).toMatch(/group 0 id=g-[0-9a-f]{16}/);
        expect(output).toContain("cursor=1");
    });

    it("rejects integer pages that advance past hidden records", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const runKV = new FakeKV();
        await feature.beforeInferenceTransact!(ctx, scope(runKV));
        await feature.afterInference!(ctx, scope(runKV), {
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        const record = [...store.records.values()][0]!;
        const malformedPage: UsagePage = {
            agentId: "agent-1",
            records: [record],
            cursor: 0,
            totalRecords: 3,
            nextCursor: 2,
        };
        const malformedFeature = new UsageFeature({
            store: {
                ...store.contract,
                read: async () => malformedPage,
            },
        });

        await expect(malformedFeature.readPage(ctx, "agent-1")).rejects.toThrow("skipping");
    });

    it("rejects aggregate cursors that skip hidden groups", async () => {
        const store = new MemoryUsageStore();
        const group: UsageSummary["groups"][number] = {
            provider: "provider-main",
            inferenceCount: 1,
            turnCount: 0,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inferenceDurationMs: 1,
            turnDurationMs: 0,
            totalDurationMs: 1,
        };
        const malformedFeature = new UsageFeature({
            store: {
                ...store.contract,
                aggregate: async () => ({
                    agentId: "agent-1",
                    cursor: 0,
                    totalGroups: 3,
                    inferenceCount: 1,
                    turnCount: 0,
                    inputTokens: 1,
                    outputTokens: 1,
                    totalTokens: 2,
                    inferenceDurationMs: 1,
                    turnDurationMs: 0,
                    totalDurationMs: 1,
                    groups: [group],
                    nextCursor: 2,
                }),
            },
        });

        await expect(
            malformedFeature.aggregate(ctx, { agentId: "agent-1", maxGroups: 1 }),
        ).rejects.toThrow("skipping");
    });

    it("denies a model tool read targeting another agent", async () => {
        const store = new MemoryUsageStore();
        const feature = makeFeature(store, () => 100);
        const tool = feature.tools(ctx, scope(new FakeKV()))[0]!;
        await expect(tool.execute(ctx, { target: "agent-2" })).rejects.toThrow("current agent");
    });
});
