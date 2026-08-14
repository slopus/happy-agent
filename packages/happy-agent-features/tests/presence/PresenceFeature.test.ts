import { createRootContext, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { AgentKV, withAgentKV, type AgentFeatureScope } from "@slopus/happy-agent-base";

import {
    PresenceFeature,
    type PresenceFeatureOptions,
    type PresenceMutationOptions,
} from "../../sources/presence/PresenceFeature.js";
import type {
    PresenceSchedule,
    PresenceScheduleInput,
} from "../../sources/presence/PresenceSchedule.js";
import type {
    PresenceEvent,
    PresenceFeatureListener,
} from "../../sources/presence/PresenceEvent.js";
import type {
    PresenceMutationReceipt,
    PresenceScheduleStore,
    PresenceStore,
    PresenceTransactionChange,
} from "../../sources/presence/PresenceStore.js";
import type { PresenceState } from "../../sources/presence/PresenceState.js";
import { presenceStateSchema } from "../../sources/presence/PresenceState.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const ctx = createRootContext().named("happy-agent-features-presence");

class FakePresenceStore implements PresenceStore {
    value: PresenceState | undefined;
    effectiveSchedule: PresenceState | undefined;
    readonly storedSchedules = new Map<string, PresenceSchedule>();
    readonly receipts = new Map<string, PresenceMutationReceipt>();
    readonly readAt: number[] = [];
    readonly scheduleLimits: number[] = [];
    setCount = 0;
    setDelayMs = 0;
    activeSets = 0;
    maxActiveSets = 0;
    forcedScheduleId: string | undefined;
    transactionResultSubstitute: ((result: unknown) => unknown) | undefined;
    #nextId = 1;
    #depth = 0;
    #callbacks: Array<(postCommitCtx: Context) => void | Promise<void>> = [];
    #tail: Promise<void> = Promise.resolve();
    readonly #activeContexts = new WeakSet<object>();
    readonly postCommitContext = createRootContext().named("presence-post-commit");
    readonly schedule: PresenceScheduleStore = {
        list: async (_ctx, options) => {
            this.scheduleLimits.push(options.limit);
            return [...this.storedSchedules.values()].slice(0, options.limit);
        },
        set: async (_ctx, input) => {
            const schedule = {
                id: this.forcedScheduleId ?? `schedule-${this.#nextId++}`,
                ...input,
            };
            this.storedSchedules.set(schedule.id, schedule);
            return schedule;
        },
        find: async (_ctx, input) =>
            [...this.storedSchedules.values()].find((schedule) => {
                const { id: _id, ...stored } = schedule;
                return JSON.stringify(stored) === JSON.stringify(input);
            }),
        clear: async (_ctx, id) => this.storedSchedules.delete(id),
    };
    readonly contract: PresenceStore = {
        transaction: this.transaction.bind(this),
        afterCommit: this.afterCommit.bind(this),
        read: this.read.bind(this),
        readConfigured: this.readConfigured.bind(this),
        set: this.set.bind(this),
        clear: this.clear.bind(this),
        readReceipt: this.readReceipt.bind(this),
        writeReceipt: this.writeReceipt.bind(this),
        schedule: this.schedule,
    };

    async transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        if (this.#activeContexts.has(ctx)) {
            return await this.#runTransaction(ctx, work);
        }
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        const txCtx = createRootContext().named("presence-transaction");
        this.#activeContexts.add(txCtx);
        try {
            return await this.#runTransaction(txCtx, work);
        } finally {
            this.#activeContexts.delete(txCtx);
            release();
        }
    }

    async #runTransaction<Result>(
        txCtx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const value = this.value;
        const schedules = new Map(this.storedSchedules);
        const receipts = new Map(this.receipts);
        const callbackCount = this.#callbacks.length;
        this.#depth++;
        try {
            const result = await work(txCtx);
            this.#depth--;
            if (this.#depth === 0) {
                const callbacks = this.#callbacks.splice(0);
                for (const callback of callbacks) await callback(this.postCommitContext);
            }
            const substituted = this.transactionResultSubstitute?.(result);
            return (substituted === undefined ? result : substituted) as Result;
        } catch (error) {
            this.#depth--;
            this.value = value;
            this.storedSchedules.clear();
            for (const [id, schedule] of schedules) this.storedSchedules.set(id, schedule);
            this.receipts.clear();
            for (const [id, receipt] of receipts) this.receipts.set(id, receipt);
            this.#callbacks.length = callbackCount;
            if (this.#depth === 0) this.#callbacks.length = 0;
            throw error;
        }
    }

    afterCommit(_ctx: Context, callback: (postCommitCtx: Context) => void | Promise<void>): void {
        if (this.#depth === 0) throw new Error("afterCommit must be registered in a transaction");
        this.#callbacks.push(callback);
    }

    async read(_ctx: Context, at: number): Promise<PresenceState | undefined> {
        this.readAt.push(at);
        const value = this.value;
        if (value === undefined) {
            return this.effectiveSchedule;
        }
        if (value.effectiveFrom !== undefined && at < value.effectiveFrom) {
            return undefined;
        }
        if (value.expiresAt !== undefined && at >= value.expiresAt) {
            return value.fallback === undefined ? undefined : { ...value.fallback };
        }
        return value;
    }

    async set(_ctx: Context, value: PresenceState, _operationId: string): Promise<void> {
        this.activeSets++;
        this.maxActiveSets = Math.max(this.maxActiveSets, this.activeSets);
        if (this.setDelayMs > 0)
            await new Promise((resolve) => setTimeout(resolve, this.setDelayMs));
        this.value = value;
        this.setCount++;
        this.activeSets--;
    }

    async clear(_ctx: Context, _operationId: string): Promise<void> {
        this.value = undefined;
    }

    async readConfigured(_ctx: Context): Promise<PresenceState | undefined> {
        return this.value;
    }

    async readReceipt(
        _ctx: Context,
        operationId: string,
    ): Promise<PresenceMutationReceipt | undefined> {
        return this.receipts.get(operationId);
    }

    async writeReceipt(_ctx: Context, receipt: PresenceMutationReceipt): Promise<void> {
        this.receipts.set(receipt.operationId, structuredClone(receipt));
    }
}

function listener(events: string[]): PresenceFeatureListener {
    return {
        onEventTransactional: (_ctx, event) => {
            events.push(`tx:${event.type}:${event.eventId}`);
        },
        onEvent: (_ctx, event) => {
            events.push(`post:${event.type}:${event.eventId}`);
        },
    };
}

function withSchedule(
    store: FakePresenceStore,
    overrides: Partial<Record<keyof PresenceScheduleStore, unknown>>,
): PresenceStore {
    return {
        transaction: store.transaction.bind(store),
        afterCommit: store.afterCommit.bind(store),
        read: store.read.bind(store),
        readConfigured: store.readConfigured.bind(store),
        set: store.set.bind(store),
        clear: store.clear.bind(store),
        readReceipt: store.readReceipt.bind(store),
        writeReceipt: store.writeReceipt.bind(store),
        schedule: { ...store.schedule, ...overrides } as PresenceScheduleStore,
    };
}

describe("PresenceFeature", () => {
    it("uses injected storage and clock for effective temporary fallback", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract, clock: () => 1_000 });

        await feature.setTemporary(ctx, {
            status: "dnd",
            message: "In a meeting",
            expiresAt: 2_000,
            fallback: { status: "online" },
        });

        expect(await feature.read(ctx)).toEqual({
            status: "dnd",
            message: "In a meeting",
            effectiveFrom: 1_000,
            expiresAt: 2_000,
            fallback: { status: "online" },
        });
        expect(store.readAt).toContain(1_000);

        const later = new PresenceFeature({ store: store.contract, clock: () => 2_000 });
        expect(await later.read(ctx)).toEqual({ status: "online" });
        expect(await later.clear(ctx)).toBe(true);
        expect(await later.read(ctx)).toBeUndefined();
    });

    it("compares and clears configured state instead of effective schedule state", async () => {
        const store = new FakePresenceStore();
        store.effectiveSchedule = { status: "away", message: "Scheduled" };
        const feature = new PresenceFeature({ store: store.contract, clock: () => 100 });
        const future = {
            status: "online" as const,
            effectiveFrom: 500,
            expiresAt: 1_000,
        };

        await feature.setPresence(ctx, future);
        const writes = store.setCount;
        await feature.setPresence(ctx, { ...future });
        expect(store.setCount).toBe(writes);
        expect(await feature.read(ctx)).toBeUndefined();
        expect(await feature.clear(ctx)).toBe(true);
        expect(store.value).toBeUndefined();

        await expect(feature.clear(ctx)).resolves.toBe(false);
    });

    it("emits transactional and post-commit events with stable identities", async () => {
        const store = new FakePresenceStore();
        const events: string[] = [];
        const feature = new PresenceFeature({
            store: store.contract,
            clock: () => 100,
            listener: listener(events),
        });

        await feature.setPresence(ctx, { status: "away", message: "Lunch" });

        expect(events).toHaveLength(2);
        expect(events[0]?.replace(/^tx:/, "")).toBe(events[1]?.replace(/^post:/, ""));
    });

    it("gives post-commit listeners a stable host context", async () => {
        const store = new FakePresenceStore();
        let transactionalContext: Context | undefined;
        let postCommitContext: Context | undefined;
        const feature = new PresenceFeature({
            store: store.contract,
            listener: {
                onEventTransactional: (eventContext) => {
                    transactionalContext = eventContext;
                },
                onEvent: (eventContext) => {
                    postCommitContext = eventContext;
                },
            },
        });

        await feature.setPresence(ctx, { status: "online" });

        expect(transactionalContext).not.toBeUndefined();
        expect(postCommitContext).toBe(store.postCommitContext);
        expect(postCommitContext).not.toBe(transactionalContext);
        expect(await store.read(postCommitContext!, 0)).toEqual({ status: "online" });
    });

    it("waits for the outermost commit before publishing post-commit events", async () => {
        const store = new FakePresenceStore();
        const events: string[] = [];
        const feature = new PresenceFeature({ store: store.contract, listener: listener(events) });

        await expect(
            store.transaction(ctx, async (outerCtx) => {
                await feature.setPresence(outerCtx, { status: "away" });
                expect(events).toEqual(["tx:presence_changed:" + events[0]?.split(":")[2]]);
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");

        expect(store.value).toBeUndefined();
        expect(events).toHaveLength(1);
    });

    it("rolls storage back when a transactional listener rejects", async () => {
        const store = new FakePresenceStore();
        const failing: PresenceFeatureListener = {
            onEventTransactional: () => {
                throw new Error("listener refused");
            },
        };
        const feature = new PresenceFeature({ store: store.contract, listener: failing });

        await expect(feature.setPresence(ctx, { status: "away" })).rejects.toThrow(
            "listener refused",
        );
        expect(store.value).toBeUndefined();
    });

    it("serializes overlapping mutations and makes identical replay a no-op", async () => {
        const store = new FakePresenceStore();
        store.setDelayMs = 5;
        const events: string[] = [];
        const feature = new PresenceFeature({ store: store.contract, listener: listener(events) });

        await Promise.all([
            feature.setPresence(ctx, { status: "away" }),
            feature.setPresence(ctx, { status: "away" }),
        ]);

        expect(store.maxActiveSets).toBe(1);
        expect(store.setCount).toBe(1);
        expect(events.filter((event) => event.startsWith("tx:"))).toHaveLength(1);
    });

    it("does not expose a model mutation tool unless explicitly enabled", () => {
        const scope = {} as AgentFeatureScope;
        const readOnly = new PresenceFeature({ store: new FakePresenceStore().contract });
        const writable = new PresenceFeature({
            store: new FakePresenceStore().contract,
            allowModelMutation: true,
        });

        expect(readOnly.tools(ctx, scope).map((tool) => tool.name)).toEqual(["get_presence"]);
        expect(writable.tools(ctx, scope).map((tool) => tool.name)).toEqual([
            "get_presence",
            "set_presence",
        ]);
    });

    it("renders concise model instructions and enforces custom-status validation", async () => {
        const feature = new PresenceFeature({ store: new FakePresenceStore().contract });

        await expect(
            feature.setPresence(ctx, { status: "custom" } as unknown as PresenceState),
        ).rejects.toThrow("Presence state is invalid.");
        await feature.setPresence(ctx, { status: "dnd", message: "Do not disturb" });

        expect(await feature.instructions(ctx, {} as AgentFeatureScope)).toBe(
            "Current user presence: do not disturb — Do not disturb.",
        );
        expect(Value.Check(presenceStateSchema, { status: "custom" })).toBe(false);
        expect(Value.Check(presenceStateSchema, { status: "away" })).toBe(true);
    });

    it("delegates recurring schedules to the host store and preserves them across feature instances", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract, clock: () => 500 });
        const input: PresenceScheduleInput = {
            days: [1, 3],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "America/Los_Angeles",
            presence: { status: "away", message: "Working remotely" },
        };

        const schedule = await feature.setSchedule(ctx, input);
        expect(await feature.listSchedules(ctx)).toEqual([schedule]);
        expect(await new PresenceFeature({ store: store.contract }).listSchedules(ctx)).toEqual([
            schedule,
        ]);
        expect(schedule.days).toEqual([1, 3]);
        expect(await feature.setSchedule(ctx, { ...input, days: [3, 1] })).toEqual(schedule);
        expect(await feature.clearSchedule(ctx, schedule.id)).toBe(true);
        expect(await feature.clearSchedule(ctx, schedule.id)).toBe(false);
    });

    it("rejects malformed mutation options at every public mutation boundary", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const temporary = {
            status: "away" as const,
            expiresAt: 2_000,
        };
        const schedule = {
            days: [1],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" as const },
        };
        const invalidOptions = [{ unexpected: true }, "not mutation options"] as const;

        for (const invalid of invalidOptions) {
            const options = invalid as unknown as PresenceMutationOptions;
            await expect(feature.setPresence(ctx, { status: "away" }, options)).rejects.toThrow(
                "Presence mutation options contain unknown or invalid keys.",
            );
            await expect(feature.clear(ctx, options)).rejects.toThrow(
                "Presence mutation options contain unknown or invalid keys.",
            );
            await expect(feature.setTemporary(ctx, temporary, options)).rejects.toThrow(
                "Presence mutation options contain unknown or invalid keys.",
            );
            await expect(feature.setSchedule(ctx, schedule, options)).rejects.toThrow(
                "Presence mutation options contain unknown or invalid keys.",
            );
            await expect(feature.clearSchedule(ctx, "schedule-1", options)).rejects.toThrow(
                "Presence mutation options contain unknown or invalid keys.",
            );
        }
    });

    it("bounds schedule reads and rejects a full schedule store", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract, maxSchedules: 2 });
        const input = {
            days: [1],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" as const },
        };

        await feature.setSchedule(ctx, input);
        await feature.setSchedule(ctx, { ...input, startTime: "10:00" });
        await expect(feature.setSchedule(ctx, { ...input, startTime: "11:00" })).rejects.toThrow(
            "schedule limit",
        );
        expect(store.scheduleLimits.every((limit) => limit <= 2)).toBe(true);
    });

    it("contains post-commit listener failures and reports them", async () => {
        const store = new FakePresenceStore();
        const errors: unknown[] = [];
        const feature = new PresenceFeature({
            store: store.contract,
            listener: {
                onEvent: async () => {
                    throw new Error("post-commit failed");
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(error);
            },
        });

        await expect(feature.setPresence(ctx, { status: "online" })).resolves.toEqual({
            status: "online",
        });
        expect(store.value).toEqual({ status: "online" });
        expect(errors).toHaveLength(1);
    });

    it("rejects schedule operations when the host did not configure scheduling", async () => {
        const store: PresenceStore = {
            transaction: async (_ctx, work) => await work(ctx),
            afterCommit: () => undefined,
            read: async () => undefined,
            readConfigured: async () => undefined,
            set: async () => undefined,
            clear: async () => undefined,
            readReceipt: async () => undefined,
            writeReceipt: async () => undefined,
        };
        const feature = new PresenceFeature({ store });

        await expect(
            feature.setSchedule(ctx, {
                days: [1],
                startTime: "09:00",
                endTime: "17:00",
                timeZone: "UTC",
                presence: { status: "away" },
            }),
        ).rejects.toThrow("scheduling is not configured");
    });

    it("rejects schedule mutation when the host omits durable identity lookup", async () => {
        const store = new FakePresenceStore();
        const invalidStore = withSchedule(store, { find: undefined });

        expect(() => new PresenceFeature({ store: invalidStore })).toThrow(
            "unknown or invalid keys",
        );
    });

    it("validates runtime scalar options and clock values", async () => {
        const store = new FakePresenceStore();
        expect(
            () =>
                new PresenceFeature({
                    store,
                    allowModelMutation: "false" as unknown as boolean,
                }),
        ).toThrow("unknown or invalid keys");

        const feature = new PresenceFeature({ store: store.contract, clock: () => -1 });
        await expect(feature.read(ctx)).rejects.toThrow("clock must return a non-negative integer");
        expect(
            () =>
                new PresenceFeature({
                    store,
                    misspelledOption: true,
                } as unknown as PresenceFeatureOptions),
        ).toThrow("unknown or invalid keys");
    });

    it("validates injected services and callbacks as closed TypeBox surfaces", () => {
        const store = new FakePresenceStore();
        const validStore = store.contract;

        expect(
            () =>
                new PresenceFeature({
                    store: { ...validStore, unexpected: true } as unknown as PresenceStore,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: {
                        ...validStore,
                        schedule: {
                            ...validStore.schedule!,
                            unexpected: true,
                        },
                    } as unknown as PresenceStore,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: {
                        ...validStore,
                        read: "not callable",
                    } as unknown as PresenceStore,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: validStore,
                    listener: {
                        onEvent: () => undefined,
                        unexpected: true,
                    } as unknown as PresenceFeatureListener,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: validStore,
                    listener: {
                        onEvent: "not callable",
                    } as unknown as PresenceFeatureListener,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: validStore,
                    clock: "not callable" as unknown as () => number,
                }),
        ).toThrow("unknown or invalid keys");
        expect(
            () =>
                new PresenceFeature({
                    store: validStore,
                    onPostCommitError: "not callable" as unknown as NonNullable<
                        PresenceFeatureOptions["onPostCommitError"]
                    >,
                }),
        ).toThrow("unknown or invalid keys");
    });

    it("clones and freezes one event for both listeners and callers", async () => {
        const store = new FakePresenceStore();
        let transactionalEvent: unknown;
        let postCommitEvent: unknown;
        const feature = new PresenceFeature({
            store: store.contract,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactionalEvent = event;
                    try {
                        const current = (
                            event as Extract<PresenceEvent, { type: "presence_changed" }>
                        ).current as unknown as { status: string };
                        current.status = "online";
                    } catch {
                        // Frozen event mutation must fail without changing the event.
                    }
                },
                onEvent: (_ctx, event) => {
                    postCommitEvent = event;
                },
            },
        });
        const input: PresenceState = {
            status: "away",
            fallback: { status: "online", message: "Later" },
        };
        const returned = await feature.setPresence(ctx, input);
        input.fallback!.message = "Caller changed this";
        returned.fallback!.message = "Result changed this";

        expect(transactionalEvent).toBe(postCommitEvent);
        expect(Object.isFrozen(transactionalEvent)).toBe(true);
        const changedEvent = transactionalEvent as Extract<
            PresenceEvent,
            { type: "presence_changed" }
        >;
        expect(Object.isFrozen(changedEvent.current)).toBe(true);
        expect(changedEvent.current.status).toBe("away");
        expect(store.value).toEqual({
            status: "away",
            fallback: { status: "online", message: "Later" },
        });
    });

    it("replays an operation receipt after an intervening opposite mutation", async () => {
        const store = new FakePresenceStore();
        const events: string[] = [];
        const feature = new PresenceFeature({
            store: store.contract,
            listener: listener(events),
        });

        await feature.setPresence(ctx, { status: "away" }, { operationId: "set-away" });
        await feature.setPresence(ctx, { status: "online" }, { operationId: "set-online" });
        await expect(
            feature.setPresence(ctx, { status: "away" }, { operationId: "set-away" }),
        ).resolves.toEqual({ status: "away" });

        expect(store.value).toEqual({ status: "online" });
        expect(events.filter((event) => event.startsWith("tx:"))).toHaveLength(2);
    });

    it("rejects a schema-valid receipt result that does not match the requested state", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const operationId = "set-away-replay";

        await feature.setPresence(ctx, { status: "away" }, { operationId });
        const receipt = store.receipts.get(operationId);
        expect(receipt).not.toBeUndefined();
        store.receipts.set(operationId, {
            ...receipt!,
            result: { status: "online" },
        });

        await expect(feature.setPresence(ctx, { status: "away" }, { operationId })).rejects.toThrow(
            "different presence state",
        );
    });

    it("rejects a schema-valid receipt result that does not match the requested schedule", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const operationId = "set-schedule-replay";
        const input: PresenceScheduleInput = {
            days: [1, 3],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" },
        };

        const schedule = await feature.setSchedule(ctx, input, { operationId });
        const receipt = store.receipts.get(operationId);
        expect(receipt).not.toBeUndefined();
        store.receipts.set(operationId, {
            ...receipt!,
            result: {
                ...schedule,
                presence: { status: "online" },
            },
        });

        await expect(feature.setSchedule(ctx, input, { operationId })).rejects.toThrow(
            "different schedule",
        );
    });

    it("rejects a schema-valid non-boolean receipt result for clear", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const operationId = "clear-replay";

        await feature.setPresence(ctx, { status: "away" });
        await feature.clear(ctx, { operationId });
        const receipt = store.receipts.get(operationId);
        expect(receipt).not.toBeUndefined();
        store.receipts.set(operationId, {
            ...receipt!,
            result: { status: "online" } as unknown as PresenceMutationReceipt["result"],
        });

        await expect(feature.clear(ctx, { operationId })).rejects.toThrow("invalid clear result");
    });

    it("allocates and reuses a feature-owned operation ID in call-scoped AgentKV", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const callCtx = withAgentKV(ctx, new AgentKV(new InMemoryPersistence(), "presence.call."));

        await feature.setPresence(callCtx, { status: "away" });
        await feature.setPresence(callCtx, { status: "away" });

        expect(store.setCount).toBe(1);
        expect(store.receipts.size).toBe(1);
    });

    it("rejects an in-place transaction result mutation", async () => {
        const store = new FakePresenceStore();
        store.transactionResultSubstitute = (result) => {
            const change = result as PresenceTransactionChange;
            (change.result as PresenceState).status = "online";
            return result;
        };
        const feature = new PresenceFeature({ store: store.contract });

        await expect(feature.setPresence(ctx, { status: "away" })).rejects.toThrow(
            "different mutation result",
        );
    });

    it("rejects a schema-valid transaction result substitution", async () => {
        const store = new FakePresenceStore();
        store.transactionResultSubstitute = (result) => ({
            ...(result as Record<string, unknown>),
            result: { status: "online" },
        });
        const feature = new PresenceFeature({ store: store.contract });

        await expect(feature.setPresence(ctx, { status: "away" })).rejects.toThrow(
            "different mutation result",
        );
    });

    it("rejects asynchronous afterCommit registration", async () => {
        const store = new FakePresenceStore();
        const invalidStore = {
            ...store.contract,
            afterCommit: (() => Promise.resolve()) as unknown as PresenceStore["afterCommit"],
        };
        const feature = new PresenceFeature({ store: invalidStore });

        await expect(feature.setPresence(ctx, { status: "away" })).rejects.toThrow(
            "register synchronously",
        );
        expect(store.value).toBeUndefined();
    });

    it("rejects a schedule ID collision returned by the host", async () => {
        const store = new FakePresenceStore();
        const feature = new PresenceFeature({ store: store.contract });
        const first = await feature.setSchedule(ctx, {
            days: [1],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" },
        });
        store.forcedScheduleId = first.id;

        await expect(
            feature.setSchedule(ctx, {
                days: [2],
                startTime: "10:00",
                endTime: "18:00",
                timeZone: "UTC",
                presence: { status: "online" },
            }),
        ).rejects.toThrow("colliding schedule ID");
    });

    it("reuses a matching listed schedule when find omits it", async () => {
        const store = new FakePresenceStore();
        const input: PresenceScheduleInput = {
            days: [1, 3],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" },
        };
        const first = await new PresenceFeature({ store: store.contract }).setSchedule(ctx, input);
        const omittedFind = withSchedule(store, {
            find: async () => undefined,
            set: async () => {
                throw new Error("schedule store set must not be called");
            },
        });
        const feature = new PresenceFeature({ store: omittedFind, maxSchedules: 1 });

        await expect(feature.setSchedule(ctx, { ...input, days: [3, 1] })).resolves.toEqual(first);
        expect(await feature.listSchedules(ctx)).toEqual([first]);
    });

    it("rejects malformed schedule results at the feature boundary", async () => {
        const input: PresenceScheduleInput = {
            days: [1],
            startTime: "09:00",
            endTime: "17:00",
            timeZone: "UTC",
            presence: { status: "away" },
        };

        const invalidList = withSchedule(new FakePresenceStore(), {
            list: async () => "not a list" as unknown as readonly PresenceSchedule[],
        });
        await expect(
            new PresenceFeature({ store: invalidList }).listSchedules(ctx),
        ).rejects.toThrow("invalid schedule list");

        const invalidFind = withSchedule(new FakePresenceStore(), {
            find: async () => null as unknown as PresenceSchedule | undefined,
        });
        await expect(
            new PresenceFeature({ store: invalidFind }).setSchedule(ctx, input),
        ).rejects.toThrow("Presence schedule is invalid");

        const mismatchedFind = withSchedule(new FakePresenceStore(), {
            find: async () => ({
                id: "existing",
                ...input,
                startTime: "10:00",
            }),
        });
        await expect(
            new PresenceFeature({ store: mismatchedFind }).setSchedule(ctx, input),
        ).rejects.toThrow("identity lookup returned a different schedule");

        const mismatchedSet = withSchedule(new FakePresenceStore(), {
            set: async (_ctx: Context, value: PresenceScheduleInput) => ({
                id: "stored",
                ...value,
                startTime: "10:00",
            }),
        });
        await expect(
            new PresenceFeature({ store: mismatchedSet }).setSchedule(ctx, input),
        ).rejects.toThrow("store returned a different schedule");

        const unsortedSet = withSchedule(new FakePresenceStore(), {
            set: async (_ctx: Context, value: PresenceScheduleInput) => ({
                id: "stored",
                ...value,
                days: [3, 1],
            }),
        });
        await expect(
            new PresenceFeature({ store: unsortedSet }).setSchedule(ctx, input),
        ).rejects.toThrow("canonical ascending order");

        const duplicate = { id: "duplicate", ...input };
        const duplicateList = withSchedule(new FakePresenceStore(), {
            list: async () => [duplicate, duplicate],
        });
        await expect(
            new PresenceFeature({ store: duplicateList }).listSchedules(ctx),
        ).rejects.toThrow("duplicate schedule IDs");

        const invalidClear = withSchedule(new FakePresenceStore(), {
            clear: async () => "yes" as unknown as boolean,
        });
        await expect(
            new PresenceFeature({ store: invalidClear }).clearSchedule(ctx, "schedule-1"),
        ).rejects.toThrow("invalid schedule removal result");
    });
});
