import { createHash } from "node:crypto";

import {
    AgentKV,
    withAgentKV,
    type AgentFeatureScope,
    type AgentPersistence,
    type AgentRecord,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    asyncLock,
    createContextNamespace,
    createRootContext,
    type Context,
} from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    GoalFeature as BaseGoalFeature,
    MAX_GOAL_CALL_EVIDENCE_BYTES,
    MAX_GOAL_CONTINUATION_PROMPT_CHARS,
    MAX_GOAL_LEDGER_BYTES,
    MAX_GOAL_OBJECTIVE_CHARS,
    MAX_GOAL_WAKE_STATE_BYTES,
    goalWakeStateSchema,
    type GoalEvent,
    type GoalFeatureOptions,
    type GoalWakeScheduler,
    type GoalWakeState,
    type SessionGoal,
} from "../../sources/index.js";
import {
    GOAL_AUTO_BLOCK_EVIDENCE_KEY,
    GOAL_AUTO_BLOCK_OPERATION_ID_KEY,
    GOAL_CONTINUATION_ID_KEY,
    GOAL_FAILURE_COUNT_KEY,
    GOAL_KEY,
    GOAL_LIFECYCLE_KEY,
    GOAL_OBSERVED_LIFECYCLE_ID_KEY,
    GOAL_OPERATIONS_KEY,
    type GoalStorage,
} from "../../sources/goal/impl/goalStore.js";
import { agentWorld } from "../support/agentWorld.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { goalStorage } from "./goalTestStorage.js";

const ctx = createRootContext().named("happy-agent-features-goal-operations");
const afterCommit = (_ctx: typeof ctx, callback: (postCommitCtx: typeof ctx) => unknown): void => {
    void callback(ctx);
};
const wakeResultSchema = Type.Object({ wake: Type.Boolean() }, { additionalProperties: false });
function defaultWakeScheduler(): GoalWakeScheduler {
    const states = new Map<string, GoalWakeState>();
    return {
        read: (_ctx, agentId) => Promise.resolve(structuredClone(states.get(agentId))),
        reconcile: (_ctx, state) => {
            states.set(state.agentId, structuredClone(state));
            return Promise.resolve();
        },
    };
}

/** Existing operation tests use an exact scheduler echo unless a durable fake is under test. */
class GoalFeature extends BaseGoalFeature {
    constructor(options: GoalFeatureOptions) {
        super(
            options.wakeScheduler === undefined
                ? { ...options, wakeScheduler: defaultWakeScheduler() }
                : options,
        );
    }
}

interface GoalReadGate {
    readonly release: Promise<void>;
    readonly observed: () => void;
}

/** Lets a test commit a new lifecycle after a stale hook has read the old goal. */
class PauseOnGoalReadPersistence extends InMemoryPersistence {
    #gate: GoalReadGate | undefined;

    pauseNextGoalRead(): { readonly paused: Promise<void>; readonly release: () => void } {
        let resolveObserved!: () => void;
        let release!: () => void;
        const paused = new Promise<void>((resolve) => {
            resolveObserved = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#gate = { release: released, observed: resolveObserved };
        return { paused, release: () => release() };
    }

    override async readValues(
        ctx: Parameters<InMemoryPersistence["readValues"]>[0],
        prefix: string,
    ) {
        const entries = await super.readValues(ctx, prefix);
        const gate = this.#gate;
        if (gate !== undefined && prefix.endsWith(".goal")) {
            this.#gate = undefined;
            gate.observed();
            await gate.release;
        }
        return entries;
    }
}

/** Returns a schema-valid but detached-wrong transaction result. */
class HostileTransactionPersistence extends InMemoryPersistence {
    mode: "none" | "substitute" | "mutate" = "none";

    override async transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const returned = await super.transaction(ctx, work);
        if (this.mode === "none" || !Value.Check(wakeResultSchema, returned)) {
            return returned as Result;
        }
        if (this.mode === "mutate") {
            (returned as { wake: boolean }).wake = !(returned as { wake: boolean }).wake;
            return returned as Result;
        }
        return { wake: !(returned as { wake: boolean }).wake } as Result;
    }
}

type AfterCallbackMutation = (txCtx: Context, persistence: InMemoryPersistence) => Promise<void>;

/** Mutates staged authoritative state after Goal's transaction callback has returned. */
class AfterCallbackMutationPersistence extends InMemoryPersistence {
    #remaining = 0;
    #mutation: AfterCallbackMutation | undefined;

    mutateAfterTransactions(count: number, mutation: AfterCallbackMutation): void {
        this.#remaining = count;
        this.#mutation = mutation;
    }

    override async transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await super.transaction(ctx, async (txCtx) => {
            const returned = await work(txCtx);
            if (this.#remaining > 0) this.#remaining -= 1;
            if (this.#remaining === 0 && this.#mutation !== undefined) {
                const mutation = this.#mutation;
                this.#mutation = undefined;
                await mutation(txCtx, this);
            }
            return returned;
        });
    }
}

/** Fails exactly one transaction so a durable tool retry can resume its retained pending state. */
class FailSecondTransactionPersistence extends InMemoryPersistence {
    transactions = 0;

    override async transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        this.transactions += 1;
        if (this.transactions === 2) throw new Error("simulated crash before Goal mutation");
        return await super.transaction(ctx, work);
    }
}

/** Serializes feature transactions while still letting outbox writes join through their txCtx. */
class SerializedGoalPersistence extends InMemoryPersistence {
    readonly #lock = asyncLock({ reentry: "allow" });
    #active = false;
    #queued: { readonly resolve: () => void } | undefined;

    observeNextQueuedTransaction(): Promise<void> {
        let resolve!: () => void;
        const promise = new Promise<void>((settled) => {
            resolve = settled;
        });
        this.#queued = { resolve };
        return promise;
    }

    override async transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        if (this.#active) {
            this.#queued?.resolve();
            this.#queued = undefined;
        }
        return await this.#lock.runInLock(ctx, async (lockCtx) => {
            this.#active = true;
            try {
                return await super.transaction(lockCtx, work);
            } finally {
                this.#active = false;
            }
        });
    }
}

interface OutermostTransactionState {
    readonly owner: OutermostCommitGoalPersistence;
    cleared: boolean;
    readonly records: AgentRecord[];
    readonly writes: Map<string, unknown>;
    readonly deletes: Set<string>;
    readonly afterCommit: ((ctx: Context) => Promise<void>)[];
}

const outermostTransactionState = createContextNamespace<OutermostTransactionState | undefined>(
    "goalOutermostTransaction",
    undefined,
);

/**
 * Transaction-aware Goal test host: nested feature transactions join one outer stage and
 * post-commit work runs only after that outermost stage commits.
 */
class OutermostCommitGoalPersistence implements AgentPersistence {
    readonly records: AgentRecord[] = [];
    readonly values = new Map<string, unknown>();

    readonly afterCommit = (
        afterCommitCtx: Context,
        callback: (postCommitCtx: Context) => Promise<void>,
    ): void => {
        const stage = this.#stage(afterCommitCtx);
        if (stage === undefined) {
            throw new Error("Goal afterCommit registration requires an active transaction.");
        }
        stage.afterCommit.push(callback);
    };

    async transaction<Result>(
        transactionCtx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        if (this.#stage(transactionCtx) !== undefined) {
            return await work(transactionCtx);
        }
        const stage: OutermostTransactionState = {
            owner: this,
            cleared: false,
            records: [],
            writes: new Map(),
            deletes: new Set(),
            afterCommit: [],
        };
        const result = await work(outermostTransactionState.set(transactionCtx, stage));
        if (stage.cleared) this.records.length = 0;
        this.records.push(...stage.records.map((record) => structuredClone(record)));
        for (const [key, value] of stage.writes) this.values.set(key, structuredClone(value));
        for (const key of stage.deletes) this.values.delete(key);
        for (const callback of stage.afterCommit) await callback(transactionCtx);
        return result;
    }

    clearRecords(clearCtx: Context): Promise<void> {
        const stage = this.#stage(clearCtx);
        if (stage === undefined) {
            this.records.length = 0;
        } else {
            stage.cleared = true;
            stage.records.length = 0;
        }
        return Promise.resolve();
    }

    load(): Promise<readonly AgentRecord[]> {
        return Promise.resolve(this.records.map((record) => structuredClone(record)));
    }

    append(appendCtx: Context, record: AgentRecord): Promise<void> {
        const stage = this.#stage(appendCtx);
        if (stage === undefined) {
            this.records.push(structuredClone(record));
        } else {
            stage.records.push(structuredClone(record));
        }
        return Promise.resolve();
    }

    readValues(
        readCtx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        const merged = new Map(this.values);
        const stage = this.#stage(readCtx);
        if (stage !== undefined) {
            for (const [key, value] of stage.writes) merged.set(key, value);
            for (const key of stage.deletes) merged.delete(key);
        }
        return Promise.resolve(
            [...merged.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, value]) => ({ key, value: structuredClone(value) })),
        );
    }

    writeValue(writeCtx: Context, key: string, value: unknown): Promise<void> {
        const stage = this.#stage(writeCtx);
        if (stage === undefined) {
            this.values.set(key, structuredClone(value));
        } else {
            stage.writes.set(key, structuredClone(value));
            stage.deletes.delete(key);
        }
        return Promise.resolve();
    }

    async writeValueIfAbsent(writeCtx: Context, key: string, value: unknown): Promise<boolean> {
        if ((await this.readValues(writeCtx, key)).some((entry) => entry.key === key)) return false;
        await this.writeValue(writeCtx, key, value);
        return true;
    }

    deleteValue(deleteCtx: Context, key: string): Promise<void> {
        const stage = this.#stage(deleteCtx);
        if (stage === undefined) {
            this.values.delete(key);
        } else {
            stage.deletes.add(key);
            stage.writes.delete(key);
        }
        return Promise.resolve();
    }

    #stage(stageCtx: Context): OutermostTransactionState | undefined {
        const stage = outermostTransactionState.get(stageCtx);
        return stage?.owner === this ? stage : undefined;
    }
}

type GoalSchedulerPersistence = Pick<AgentPersistence, "readValues" | "writeValue">;

/** A restart-readable latest-state outbox backed by the same host transaction as Goal. */
class TransactionalGoalWakeScheduler implements GoalWakeScheduler {
    readonly requests: GoalWakeState[] = [];
    readonly #persistence: (agentId: string) => GoalSchedulerPersistence;
    #gate:
        | {
              readonly entered: () => void;
              readonly release: Promise<void>;
          }
        | undefined;
    failAfterWrite = false;

    constructor(
        persistence: GoalSchedulerPersistence | ((agentId: string) => GoalSchedulerPersistence),
    ) {
        this.#persistence =
            typeof persistence === "function" ? persistence : (_agentId) => persistence;
    }

    pauseNextSend(): { readonly entered: Promise<void>; readonly release: () => void } {
        let entered!: () => void;
        let release!: () => void;
        const observed = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#gate = { entered, release: released };
        return { entered: observed, release };
    }

    async reconcile(reconcileCtx: Context, request: GoalWakeState): Promise<void> {
        this.requests.push(structuredClone(request));
        const gate = this.#gate;
        if (gate !== undefined) {
            this.#gate = undefined;
            gate.entered();
            await gate.release;
        }
        const persistence = this.#persistence(request.agentId);
        const key = this.#key(request.agentId);
        await persistence.writeValue(reconcileCtx, key, structuredClone(request));
        if (this.failAfterWrite) {
            this.failAfterWrite = false;
            throw new Error("wake scheduler failed");
        }
        const persisted = await this.read(reconcileCtx, request.agentId);
        if (persisted === undefined) {
            throw new Error("wake scheduler lost its latest state");
        }
    }

    async read(readCtx: Context, agentId: string): Promise<GoalWakeState | undefined> {
        const key = this.#key(agentId);
        const entry = (await this.#persistence(agentId).readValues(readCtx, key)).find(
            (candidate) => candidate.key === key,
        );
        if (entry === undefined) return undefined;
        if (!Value.Check(goalWakeStateSchema, entry.value)) {
            throw new Error("wake scheduler retained malformed state");
        }
        return structuredClone(entry.value) as GoalWakeState;
    }

    async recover(
        recoverCtx: Context,
        agentId: string,
        deliver: (state: Extract<GoalWakeState, { state: "scheduled" }>) => Promise<void>,
    ): Promise<void> {
        const state = await this.read(recoverCtx, agentId);
        if (state?.state === "scheduled") await deliver(structuredClone(state));
    }

    #key(agentId: string): string {
        return `goal-wake.${agentId}`;
    }
}

function goalStorageOfPersistence(persistence: AgentPersistence): GoalStorage {
    return {
        persistence: () => persistence,
    } as unknown as GoalStorage;
}

function goalScope(persistence: InMemoryPersistence, agentId: string): AgentFeatureScope {
    const root = new AgentKV(persistence, `kv.${agentId}.`);
    return {
        agent: { id: agentId },
        kv: root.scoped("feature", "goal"),
        runKV: root.scoped("run", "feature", "goal"),
    } as unknown as AgentFeatureScope;
}

function goalToolCall(
    persistence: InMemoryPersistence,
    agentId: string,
    callId: string,
): {
    readonly executeCtx: typeof ctx;
    readonly hookCtx: typeof ctx;
    readonly hookScope: AgentFeatureScope;
    readonly kv: AgentKV;
} {
    const root = new AgentKV(persistence, `kv.${agentId}.`);
    const call = root.scoped("call", callId);
    const kv = call.scoped("feature", "goal");
    return {
        executeCtx: withAgentKV(ctx, call),
        hookCtx: withAgentKV(ctx, kv),
        hookScope: {
            agent: { id: agentId },
            kv,
            runKV: root.scoped("run", "call", callId, "feature", "goal"),
        } as unknown as AgentFeatureScope,
        kv,
    };
}

function requiredGoalTool(
    goals: GoalFeature,
    scope: AgentFeatureScope,
    name: string,
): AnyAgentTool {
    const tool = goals.tools(ctx, scope).find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing Goal tool ${name}.`);
    return tool;
}

/** A feature whose events are recorded as they arrive, transactional ones marked as such. */
function recordingFeature(): { goals: GoalFeature; events: string[] } {
    const events: string[] = [];
    const describe_ = (event: GoalEvent): string =>
        event.type === "goal_cleared"
            ? `${event.type} ${event.agentId}`
            : `${event.type} ${event.agentId} ${event.goal.status}`;
    const goals = new GoalFeature({
        afterCommit,
        storage: goalStorage(agentWorld().storage),
        listener: {
            onEventTransactional: (_ctx, event) => {
                events.push(`transactional: ${describe_(event)}`);
            },
            onEvent: (_ctx, event) => {
                events.push(`committed: ${describe_(event)}`);
            },
        },
    });
    return { goals, events };
}

describe("goal operations", () => {
    it("sets, reads, and clears the goal of an agent that has never run", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });

        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
        const goal = await goals.setGoal(ctx, "agent-1", "  ship the thing  ");

        expect(goal).toEqual({
            createdAt: expect.any(Number),
            objective: "ship the thing",
            status: "active",
            updatedAt: goal.createdAt,
        });
        expect(await goals.goal(ctx, "agent-1")).toEqual(goal);
        expect(await goals.clearGoal(ctx, "agent-1")).toBe(true);
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
        expect(await goals.clearGoal(ctx, "agent-1")).toBe(false);
    });

    it("keeps each agent's goal to itself", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });

        await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(await goals.goal(ctx, "agent-2")).toBeUndefined();
    });

    it("refuses an objective that says nothing", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });

        await expect(goals.setGoal(ctx, "agent-1", "   ")).rejects.toThrow("must not be empty");
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
    });

    it("refuses to replace a goal that is not finished", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });
        const first = await goals.setGoal(ctx, "agent-1", "ship the thing");

        await expect(goals.setGoal(ctx, "agent-1", "ship something else")).rejects.toThrow(
            "already has an unfinished goal",
        );
        expect(await goals.goal(ctx, "agent-1")).toEqual(first);
    });

    it("answers a repeated call with the goal it already started", async () => {
        const { goals, events } = recordingFeature();
        const first = await goals.setGoal(ctx, "agent-1", "ship the thing");

        const again = await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(again).toEqual(first);
        expect(events).toEqual([
            "transactional: goal_set agent-1 active",
            "committed: goal_set agent-1 active",
        ]);
    });

    it("starts a new goal once the previous one is complete", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });
        await goals.setGoal(ctx, "agent-1", "ship the thing");
        await goals.changeGoalStatus(ctx, "agent-1", "complete");

        const next = await goals.setGoal(ctx, "agent-1", "ship the next thing");

        expect(next.status).toBe("active");
        expect(next.objective).toBe("ship the next thing");
    });

    it("moves the goal between statuses and says nothing about a status it already has", async () => {
        const { goals, events } = recordingFeature();
        const created = await goals.setGoal(ctx, "agent-1", "ship the thing");
        events.length = 0;

        const paused = await goals.changeGoalStatus(ctx, "agent-1", "paused");
        const unchanged = await goals.changeGoalStatus(ctx, "agent-1", "paused");

        expect(paused).toEqual({ ...created, status: "paused", updatedAt: paused.updatedAt });
        expect(unchanged).toEqual(paused);
        expect(events).toEqual([
            "transactional: goal_status_changed agent-1 paused",
            "committed: goal_status_changed agent-1 paused",
        ]);
    });

    it("says so when there is no goal to change", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });

        await expect(goals.changeGoalStatus(ctx, "agent-1", "complete")).rejects.toThrow(
            "does not have a goal",
        );
    });

    it("tells the transactional listener before the change is readable, and the other after", async () => {
        const world = agentWorld();
        const seen: string[] = [];
        const goals: GoalFeature = new GoalFeature({
            afterCommit,
            storage: goalStorage(world.storage),
            listener: {
                onEventTransactional: async (txCtx) => {
                    // The change has not committed yet, so a reader outside the transaction
                    // still sees the store as it was.
                    seen.push(`transactional sees ${String(await goals.goal(ctx, "agent-1"))}`);
                    void txCtx;
                },
                onEvent: () => {
                    seen.push("committed");
                },
            },
        });

        await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(seen).toEqual(["transactional sees undefined", "committed"]);
        expect((await goals.goal(ctx, "agent-1"))?.objective).toBe("ship the thing");
    });

    it("rolls the change back when the transactional listener fails", async () => {
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorage(agentWorld().storage),
            listener: {
                onEventTransactional: () => {
                    throw new Error("the listener refused");
                },
            },
        });

        await expect(goals.setGoal(ctx, "agent-1", "ship the thing")).rejects.toThrow(
            "the listener refused",
        );
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
    });

    it("keeps concurrent same-operation calls idempotent", async () => {
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(agentWorld().storage) });

        const [first, second] = await Promise.allSettled([
            goals.setGoal(ctx, "agent-1", "ship the thing", { operationId: "same-operation" }),
            goals.setGoal(ctx, "agent-1", "ship the thing", { operationId: "same-operation" }),
        ]);

        expect([first?.status, second?.status]).toEqual(["fulfilled", "fulfilled"]);
        expect((await goals.goal(ctx, "agent-1"))?.status).toBe("active");
    });

    it("resumes a pending tool operation with one identity after a crash before mutation", async () => {
        const persistence = new FailSecondTransactionPersistence();
        let factoryCalls = 0;
        const goals = new GoalFeature({
            afterCommit,
            idFactory: () => {
                factoryCalls += 1;
                return "pending-tool-operation";
            },
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "pending-tool-agent";
        const scope = goalScope(persistence, agentId);
        const call = goalToolCall(persistence, agentId, "pending-call");
        const tool = requiredGoalTool(goals, scope, "create_goal");

        await expect(
            tool.execute(call.executeCtx, { objective: "ship the thing" }),
        ).rejects.toThrow("simulated crash");
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "pending",
            request: { operationId: "pending-tool-operation" },
        });

        await expect(
            tool.execute(call.executeCtx, { objective: "ship the thing" }),
        ).resolves.toMatchObject({
            goal: { objective: "ship the thing", status: "active" },
        });
        expect(factoryCalls).toBe(1);
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "completed",
            request: { operationId: "pending-tool-operation" },
        });
        expect([...persistence.values.keys()].some((key) => key.endsWith(".operations"))).toBe(
            false,
        );
    });

    it("commits completed tool evidence atomically with the Goal mutation", async () => {
        const persistence = new InMemoryPersistence();
        const storage = goalStorageOfPersistence(persistence);
        const agentId = "atomic-tool-agent";
        const scope = goalScope(persistence, agentId);
        const call = goalToolCall(persistence, agentId, "atomic-call");
        const rejecting = new GoalFeature({
            afterCommit,
            idFactory: () => "atomic-tool-operation",
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject atomic Goal mutation");
                },
            },
            storage,
        });

        await expect(
            requiredGoalTool(rejecting, scope, "create_goal").execute(call.executeCtx, {
                objective: "ship atomically",
            }),
        ).rejects.toThrow("reject atomic Goal mutation");
        await expect(rejecting.goal(ctx, agentId)).resolves.toBeUndefined();
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "pending",
            request: { operationId: "atomic-tool-operation" },
        });

        const restarted = new GoalFeature({
            afterCommit,
            idFactory: () => {
                throw new Error("atomic retry allocated another operation");
            },
            storage,
        });
        await expect(
            requiredGoalTool(restarted, scope, "create_goal").execute(call.executeCtx, {
                objective: "ship atomically",
            }),
        ).resolves.toMatchObject({
            goal: { objective: "ship atomically", status: "active" },
        });
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "completed",
        });
    });

    it("retains maximum legal tool input within the call evidence byte bound", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            idFactory: () => "maximum-tool-operation",
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "maximum-tool-agent";
        const call = goalToolCall(persistence, agentId, "maximum-call");
        const objective = "\0".repeat(MAX_GOAL_OBJECTIVE_CHARS);

        await expect(
            requiredGoalTool(goals, goalScope(persistence, agentId), "create_goal").execute(
                call.executeCtx,
                { objective },
            ),
        ).resolves.toMatchObject({
            goal: { objective, status: "active" },
        });
        const evidence = await call.kv.read(ctx, "operation");
        expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBeLessThanOrEqual(
            MAX_GOAL_CALL_EVIDENCE_BYTES,
        );
    });

    it("replays completed tool evidence after an opposite transition without changing current state", async () => {
        const persistence = new InMemoryPersistence();
        let factoryCalls = 0;
        const storage = goalStorageOfPersistence(persistence);
        const firstFeature = new GoalFeature({
            afterCommit,
            idFactory: () => {
                factoryCalls += 1;
                return "completed-tool-operation";
            },
            storage,
        });
        const agentId = "completed-tool-agent";
        const scope = goalScope(persistence, agentId);
        const call = goalToolCall(persistence, agentId, "completed-call");
        const firstTool = requiredGoalTool(firstFeature, scope, "create_goal");
        const first = await firstTool.execute(call.executeCtx, {
            objective: "ship the thing",
        });

        await firstFeature.clearGoal(ctx, agentId, { operationId: "clear-after-tool" });
        const replayEvents: GoalEvent[] = [];
        const restarted = new GoalFeature({
            afterCommit,
            idFactory: () => {
                throw new Error("completed tool replay allocated another identity");
            },
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    replayEvents.push(event);
                },
            },
            storage,
        });
        const replayTool = requiredGoalTool(restarted, scope, "create_goal");

        await expect(
            replayTool.execute(call.executeCtx, { objective: "ship the thing" }),
        ).resolves.toEqual(first);
        await expect(restarted.goal(ctx, agentId)).resolves.toBeUndefined();
        expect(factoryCalls).toBe(1);
        expect(replayEvents).toEqual([]);
        expect(goalLedgerOperationIds(persistence)).toEqual(["clear-after-tool"]);
        await expect(
            replayTool.execute(call.executeCtx, { objective: "different input" }),
        ).rejects.toThrow("original input");
    });

    it("keeps tool evidence outside a full host ledger and clears it only with a committed tool result", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            idFactory: () => "pressure-tool-operation",
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "pressure-tool-agent";
        const seedGoal: SessionGoal = {
            createdAt: 1,
            objective: "seed",
            status: "active",
            updatedAt: 1,
        };
        const scope = goalScope(persistence, agentId);
        const ledgerKey = `${scope.kv.prefix}operations`;
        persistence.values.set(
            ledgerKey,
            Array.from({ length: 256 }, (_, index) =>
                goalEvidence(agentId, `host-${String(index).padStart(3, "0")}`, seedGoal),
            ),
        );
        const call = goalToolCall(persistence, agentId, "pressure-call");
        const tool = requiredGoalTool(goals, scope, "create_goal");
        const result = await tool.execute(call.executeCtx, {
            objective: "tool operation bypasses host pressure",
        });

        expect(goalLedgerOperationIds(persistence)).toHaveLength(256);
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "completed",
            request: { operationId: "pressure-tool-operation" },
        });
        await expect(
            tool.execute(call.executeCtx, {
                objective: "tool operation bypasses host pressure",
            }),
        ).resolves.toEqual(result);
        await expect(
            tool.execute(call.executeCtx, { objective: "different pressure input" }),
        ).rejects.toThrow("original input");

        await expect(
            persistence.transaction(ctx, async (txCtx) => {
                await goals.afterToolCallTransact(withAgentKV(txCtx, call.kv), call.hookScope);
                throw new Error("roll back tool result");
            }),
        ).rejects.toThrow("roll back tool result");
        await expect(call.kv.read(ctx, "operation")).resolves.toMatchObject({
            state: "completed",
        });

        await persistence.transaction(ctx, async (txCtx) => {
            await goals.afterToolCallTransact(withAgentKV(txCtx, call.kv), call.hookScope);
        });
        await expect(call.kv.read(ctx, "operation")).resolves.toBeUndefined();
        expect(goalLedgerOperationIds(persistence)).toHaveLength(256);
    });

    it("backpressures an unseen host operation at count capacity without mutating, and replays retained evidence", async () => {
        const persistence = new InMemoryPersistence();
        const events: GoalEvent[] = [];
        const goals = new GoalFeature({
            afterCommit,
            clock: () => 1,
            storage: goalStorageOfPersistence(persistence),
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(event);
                },
            },
        });
        const agentId = "retention-agent";

        const goal = await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "retained-operation",
        });
        const ledgerKey = goalLedgerKey(persistence);
        const retained = persistence.values.get(ledgerKey);
        if (!Array.isArray(retained) || retained.length !== 1) {
            throw new Error("Missing retained Goal operation.");
        }
        persistence.values.set(ledgerKey, [
            ...structuredClone(retained),
            ...Array.from({ length: 255 }, (_, index) =>
                goalEvidence(agentId, `z-${String(index).padStart(3, "0")}`, goal),
            ),
        ]);

        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "retained-operation",
            }),
        ).resolves.toEqual(goal);
        await expect(
            goals.changeGoalStatus(ctx, agentId, "paused", {
                operationId: "unseen-at-capacity",
            }),
        ).rejects.toThrow("capacity is full");

        expect(await goals.goal(ctx, agentId)).toEqual(goal);
        expect(events).toHaveLength(1);
        expect(goalLedgerOperationIds(persistence)).toHaveLength(256);
        expect(goalLedgerOperationIds(persistence)).toContain("retained-operation");
        expect(goalLedgerOperationIds(persistence)).not.toContain("unseen-at-capacity");

        const scope = goalScope(persistence, agentId);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await goals.beforeAgentLoop(ctx, scope);
            await goals.afterInference(ctx, scope, {
                state: "error",
                tokens: { input: 0, output: 0 },
            });
            await goals.afterAgentLoop(ctx, scope);
        }
        expect((await goals.goal(ctx, agentId))?.status).toBe("blocked");
        expect(goalLedgerOperationIds(persistence)).toHaveLength(256);
        expect(events).toHaveLength(2);
    });

    it("backpressures an unseen host operation at byte capacity without mutating", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            clock: () => 1,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "byte-retention-agent";
        const goal = await goals.setGoal(ctx, agentId, "x".repeat(MAX_GOAL_OBJECTIVE_CHARS), {
            operationId: "seed-byte-base",
        });
        const ledgerKey = goalLedgerKey(persistence);
        const seeded: ReturnType<typeof goalEvidence>[] = [];
        for (let index = 0; ; index += 1) {
            const next = [
                ...seeded,
                goalEvidence(agentId, `z-byte-${String(index).padStart(3, "0")}`, goal),
            ];
            if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_GOAL_LEDGER_BYTES) break;
            seeded.push(next[next.length - 1] as ReturnType<typeof goalEvidence>);
        }
        expect(seeded.length).toBeGreaterThan(1);
        persistence.values.set(ledgerKey, structuredClone(seeded));

        await expect(
            goals.changeGoalStatus(ctx, agentId, "paused", {
                operationId: "unseen-byte-operation",
            }),
        ).rejects.toThrow("byte capacity is full");

        const ledger = persistence.values.get(ledgerKey);
        if (!Array.isArray(ledger)) throw new Error("Missing Goal operation ledger.");
        expect(ledger).toEqual(seeded);
        expect(Buffer.byteLength(JSON.stringify(ledger), "utf8")).toBeLessThanOrEqual(
            MAX_GOAL_LEDGER_BYTES,
        );
        expect((await goals.goal(ctx, agentId))?.status).toBe("active");
    });

    it("rejects receipt-only and proof-only evidence on ordinary persisted loads", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "orphan-ledger-agent";
        await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "paired-operation",
        });
        const ledgerKey = goalLedgerKey(persistence);
        const ledger = persistence.values.get(ledgerKey);
        if (
            !Array.isArray(ledger) ||
            ledger.length !== 1 ||
            ledger[0]?.receipt === undefined ||
            ledger[0]?.proof === undefined
        ) {
            throw new Error("Missing paired Goal evidence.");
        }
        const [evidence] = structuredClone(ledger);

        persistence.values.set(ledgerKey, [{ receipt: evidence.receipt }]);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow();
        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "paired-operation",
            }),
        ).rejects.toThrow();

        persistence.values.set(ledgerKey, [{ proof: evidence.proof }]);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow();
        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "paired-operation",
            }),
        ).rejects.toThrow();
    });

    it("rolls back the complete evidence pair with a rejected transaction", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject complete evidence");
                },
            },
        });

        await expect(
            goals.setGoal(ctx, "pair-rollback-agent", "ship the thing", {
                operationId: "pair-rollback",
            }),
        ).rejects.toThrow("reject complete evidence");
        expect([...persistence.values.keys()].some((key) => key.endsWith(".operations"))).toBe(
            false,
        );
        await expect(goals.goal(ctx, "pair-rollback-agent")).resolves.toBeUndefined();
    });

    it("clears automatic-block state outside active lifecycles and recreates it on resume", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "sidecar-agent";
        const scope = goalScope(persistence, agentId);

        await goals.setGoal(ctx, agentId, "ship the thing", { operationId: "set-sidecar" });
        const firstLifecycle = await scope.kv.read(ctx, GOAL_LIFECYCLE_KEY);
        const firstSidecar = await scope.kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
        expect(firstSidecar).toBe(expectedAutomaticBlockId(lifecycleId(firstLifecycle)));

        await goals.changeGoalStatus(ctx, agentId, "paused", { operationId: "pause-sidecar" });
        expect(await scope.kv.read(ctx, GOAL_LIFECYCLE_KEY)).toBeUndefined();
        expect(await scope.kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY)).toBeUndefined();

        await goals.changeGoalStatus(ctx, agentId, "active", { operationId: "resume-sidecar" });
        const resumedLifecycle = await scope.kv.read(ctx, GOAL_LIFECYCLE_KEY);
        const resumedSidecar = await scope.kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
        expect(lifecycleId(resumedLifecycle)).not.toBe(lifecycleId(firstLifecycle));
        expect(resumedSidecar).toBe(expectedAutomaticBlockId(lifecycleId(resumedLifecycle)));
        expect(resumedSidecar).not.toBe(firstSidecar);

        await goals.changeGoalStatus(ctx, agentId, "complete", {
            operationId: "complete-sidecar",
        });
        expect(await scope.kv.read(ctx, GOAL_LIFECYCLE_KEY)).toBeUndefined();
        expect(await scope.kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY)).toBeUndefined();
    });

    it("does not let a stale failed hook increment or block a replacement lifecycle", async () => {
        const persistence = new PauseOnGoalReadPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "stale-hook-agent";
        const scope = goalScope(persistence, agentId);

        await goals.setGoal(ctx, agentId, "first objective", { operationId: "set-first" });
        await goals.beforeAgentLoop(ctx, scope);
        await goals.afterInference(ctx, scope, {
            state: "error",
            tokens: { input: 0, output: 0 },
        });

        const gate = persistence.pauseNextGoalRead();
        const staleHook = goals.afterAgentLoop(ctx, scope);
        await gate.paused;

        await goals.clearGoal(ctx, agentId, { operationId: "clear-first" });
        await goals.setGoal(ctx, agentId, "second objective", { operationId: "set-second" });
        gate.release();
        await expect(staleHook).rejects.toThrow("exact lifecycle sidecar");

        expect(await goals.goal(ctx, agentId)).toEqual({
            createdAt: expect.any(Number),
            objective: "second objective",
            status: "active",
            updatedAt: expect.any(Number),
        });
        expect(await scope.kv.read(ctx, GOAL_FAILURE_COUNT_KEY)).toBeUndefined();
    });

    it("does nothing when afterAgentLoop has no observed lifecycle snapshot", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "missing-snapshot-agent";
        const scope = goalScope(persistence, agentId);

        await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "set-missing-snapshot",
        });
        await goals.afterInference(ctx, scope, {
            state: "error",
            tokens: { input: 0, output: 0 },
        });

        await expect(goals.afterAgentLoop(ctx, scope)).resolves.toBeUndefined();
        expect(await scope.kv.read(ctx, GOAL_FAILURE_COUNT_KEY)).toBeUndefined();
        expect((await goals.goal(ctx, agentId))?.status).toBe("active");
    });

    it("rejects an active goal whose durable lifecycle identity is missing", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "missing-lifecycle-agent";
        const scope = goalScope(persistence, agentId);

        await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "set-missing-lifecycle",
        });
        await scope.kv.delete(ctx, GOAL_LIFECYCLE_KEY);

        await expect(goals.beforeAgentLoop(ctx, scope)).rejects.toThrow(
            "requires its exact lifecycle sidecar",
        );
        expect(await scope.kv.read(ctx, GOAL_LIFECYCLE_KEY)).toBeUndefined();
        await expect(goals.goal(ctx, agentId)).rejects.toThrow(
            "requires its exact lifecycle sidecar",
        );
    });

    it("rejects a schema-valid automatic block identity from another lifecycle", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "wrong-auto-block-agent";
        const scope = goalScope(persistence, agentId);

        await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "set-wrong-auto-block",
        });
        await goals.beforeAgentLoop(ctx, scope);
        await goals.afterInference(ctx, scope, {
            state: "error",
            tokens: { input: 0, output: 0 },
        });
        await scope.kv.write(ctx, GOAL_FAILURE_COUNT_KEY, 2);
        await scope.kv.write(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY, "other-lifecycle-block");

        await expect(goals.afterAgentLoop(ctx, scope)).rejects.toThrow(
            "exact automatic-block operation identity",
        );
        expect(await scope.kv.read(ctx, GOAL_FAILURE_COUNT_KEY)).toBe(2);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow(
            "exact automatic-block operation identity",
        );
    });

    it("atomically rolls back a failed wake schedule and replays a committed schedule once", async () => {
        const persistence = new SerializedGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        wakeScheduler.failAfterWrite = true;
        const events: GoalEvent[] = [];
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(event);
                },
            },
        });

        await expect(
            goals.setGoal(ctx, "wake-retry-agent", "ship the thing", {
                operationId: "wake-retry-operation",
            }),
        ).rejects.toThrow("wake scheduler failed");
        await expect(goals.goal(ctx, "wake-retry-agent")).resolves.toBeUndefined();
        await expect(wakeScheduler.read(ctx, "wake-retry-agent")).resolves.toBeUndefined();
        expect(events).toEqual([]);

        const persisted = await goals.setGoal(ctx, "wake-retry-agent", "ship the thing", {
            operationId: "wake-retry-operation",
        });
        const replayed = await goals.setGoal(ctx, "wake-retry-agent", "ship the thing", {
            operationId: "wake-retry-operation",
        });

        expect(replayed).toEqual(persisted);
        expect(wakeScheduler.requests).toHaveLength(2);
        expect(wakeScheduler.requests[1]).toMatchObject({
            state: "scheduled",
            lifecycleId: "wake-retry-operation",
        });
        await expect(wakeScheduler.read(ctx, "wake-retry-agent")).resolves.toEqual(
            wakeScheduler.requests[1],
        );
        expect(events).toHaveLength(1);
    });

    it("rolls back when a scheduler substitutes another schema-valid latest state", async () => {
        const persistence = new InMemoryPersistence();
        let substituted: GoalWakeState | undefined;
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler: {
                read: () => Promise.resolve(structuredClone(substituted)),
                reconcile: (_reconcileCtx, state) => {
                    substituted =
                        state.state === "scheduled"
                            ? { ...state, messageId: "gsubstituted" }
                            : state;
                    return Promise.resolve();
                },
            },
        });

        await expect(
            goals.setGoal(ctx, "substituted-scheduler-agent", "ship the thing", {
                operationId: "substituted-scheduler-operation",
            }),
        ).rejects.toThrow("did not retain the requested latest state");
        await expect(goals.goal(ctx, "substituted-scheduler-agent")).resolves.toBeUndefined();
    });

    it("rejects open or synchronous scheduler adapters at the runtime boundary", async () => {
        const persistence = new InMemoryPersistence();
        const storage = goalStorageOfPersistence(persistence);
        expect(
            () =>
                new BaseGoalFeature({
                    afterCommit,
                    storage,
                    wakeScheduler: {
                        read: () => Promise.resolve(undefined),
                        reconcile: () => Promise.resolve(),
                        rogue: true,
                    },
                } as unknown as GoalFeatureOptions),
        ).toThrow("options are invalid");

        const synchronous = new BaseGoalFeature({
            afterCommit,
            storage,
            wakeScheduler: {
                read: () => Promise.resolve(undefined),
                reconcile: (() => undefined) as unknown as GoalWakeScheduler["reconcile"],
            },
        });
        await expect(
            synchronous.setGoal(ctx, "sync-scheduler-agent", "ship the thing", {
                operationId: "sync-scheduler-operation",
            }),
        ).rejects.toThrow("must return a Promise");
        await expect(synchronous.goal(ctx, "sync-scheduler-agent")).resolves.toBeUndefined();
    });

    it("rolls back the durable schedule when a later transactional observer rejects", async () => {
        const persistence = new InMemoryPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject after scheduling");
                },
            },
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });

        await expect(
            goals.setGoal(ctx, "observer-rollback-agent", "ship the thing", {
                operationId: "observer-rollback-operation",
            }),
        ).rejects.toThrow("reject after scheduling");
        await expect(goals.goal(ctx, "observer-rollback-agent")).resolves.toBeUndefined();
        await expect(wakeScheduler.read(ctx, "observer-rollback-agent")).resolves.toBeUndefined();
    });

    it("serializes a durable schedule and a later pause cancellation", async () => {
        const persistence = new SerializedGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });
        const gate = wakeScheduler.pauseNextSend();
        let setSettled = false;
        const setting = goals
            .setGoal(ctx, "atomic-wake-agent", "ship the thing", {
                operationId: "atomic-wake-set",
            })
            .then((goal) => {
                setSettled = true;
                return goal;
            });
        await gate.entered;

        const pauseQueued = persistence.observeNextQueuedTransaction();
        let pauseSettled = false;
        const pausing = goals
            .changeGoalStatus(ctx, "atomic-wake-agent", "paused", {
                operationId: "atomic-wake-pause",
            })
            .then((goal) => {
                pauseSettled = true;
                return goal;
            });
        await pauseQueued;

        expect(setSettled).toBe(false);
        expect(pauseSettled).toBe(false);
        await expect(wakeScheduler.read(ctx, "atomic-wake-agent")).resolves.toBeUndefined();

        gate.release();
        const [setGoal, pausedGoal] = await Promise.all([setting, pausing]);

        expect(setGoal.status).toBe("active");
        expect(pausedGoal.status).toBe("paused");
        expect((await goals.goal(ctx, "atomic-wake-agent"))?.status).toBe("paused");
        await expect(wakeScheduler.read(ctx, "atomic-wake-agent")).resolves.toEqual({
            state: "cancelled",
            agentId: "atomic-wake-agent",
            operationId: "atomic-wake-pause",
        });
        expect(wakeScheduler.requests.map((request) => request.state)).toEqual([
            "scheduled",
            "cancelled",
        ]);
    });

    it("does not reschedule historical evidence after a later pause", async () => {
        const persistence = new SerializedGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });

        const first = await goals.setGoal(ctx, "wake-suppressed-agent", "ship the thing", {
            operationId: "wake-suppressed-operation",
        });
        await goals.changeGoalStatus(ctx, "wake-suppressed-agent", "paused", {
            operationId: "pause-after-wake",
        });
        const historical = await goals.setGoal(ctx, "wake-suppressed-agent", "ship the thing", {
            operationId: "wake-suppressed-operation",
        });

        expect(historical).toEqual(first);
        expect((await goals.goal(ctx, "wake-suppressed-agent"))?.status).toBe("paused");
        expect(wakeScheduler.requests).toHaveLength(2);
        await expect(wakeScheduler.read(ctx, "wake-suppressed-agent")).resolves.toEqual({
            state: "cancelled",
            agentId: "wake-suppressed-agent",
            operationId: "pause-after-wake",
        });
    });

    it("replays exact external set and resume operations after restart without a scheduler", async () => {
        const persistence = new SerializedGoalPersistence();
        const storage = goalStorageOfPersistence(persistence);
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const configured = new GoalFeature({ afterCommit, storage, wakeScheduler });
        const agentId = "schedulerless-replay-agent";
        const set = await configured.setGoal(ctx, agentId, "ship the thing", {
            operationId: "schedulerless-replay-set",
        });
        await configured.changeGoalStatus(ctx, agentId, "paused", {
            operationId: "schedulerless-replay-pause",
        });
        const resumed = await configured.changeGoalStatus(ctx, agentId, "active", {
            operationId: "schedulerless-replay-resume",
        });
        const requestsBeforeReplay = structuredClone(wakeScheduler.requests);
        const restarted = new BaseGoalFeature({ afterCommit, storage });

        await expect(
            restarted.setGoal(ctx, agentId, "ship the thing", {
                operationId: "schedulerless-replay-set",
            }),
        ).resolves.toEqual(set);
        await expect(
            restarted.changeGoalStatus(ctx, agentId, "active", {
                operationId: "schedulerless-replay-resume",
            }),
        ).resolves.toEqual(resumed);
        expect(wakeScheduler.requests).toEqual(requestsBeforeReplay);
    });

    it("accepts unchanged external active operations after restart without a scheduler", async () => {
        const persistence = new SerializedGoalPersistence();
        const storage = goalStorageOfPersistence(persistence);
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const configured = new GoalFeature({ afterCommit, storage, wakeScheduler });
        const agentId = "schedulerless-noop-agent";
        const active = await configured.setGoal(ctx, agentId, "ship the thing", {
            operationId: "schedulerless-noop-set",
        });
        const restarted = new BaseGoalFeature({ afterCommit, storage });

        await expect(
            restarted.setGoal(ctx, agentId, "ship the thing", {
                operationId: "schedulerless-noop-repeat-set",
            }),
        ).resolves.toEqual(active);
        await expect(
            restarted.changeGoalStatus(ctx, agentId, "active", {
                operationId: "schedulerless-noop-active",
            }),
        ).resolves.toEqual(active);
        expect(wakeScheduler.requests).toHaveLength(1);
    });

    it("rolls back a changed external resume without a scheduler before durable effects", async () => {
        const persistence = new SerializedGoalPersistence();
        const storage = goalStorageOfPersistence(persistence);
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const configured = new GoalFeature({ afterCommit, storage, wakeScheduler });
        const agentId = "schedulerless-changed-resume-agent";
        await configured.setGoal(ctx, agentId, "ship the thing", {
            operationId: "schedulerless-changed-set",
        });
        const paused = await configured.changeGoalStatus(ctx, agentId, "paused", {
            operationId: "schedulerless-changed-pause",
        });
        const beforeValues = structuredClone([...persistence.values.entries()]);
        const events: GoalEvent[] = [];
        const restarted = new BaseGoalFeature({
            afterCommit,
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(event);
                },
            },
            storage,
        });

        await expect(
            restarted.changeGoalStatus(ctx, agentId, "active", {
                operationId: "schedulerless-changed-resume",
            }),
        ).rejects.toThrow("requires a durable wake scheduler");
        await expect(restarted.goal(ctx, agentId)).resolves.toEqual(paused);
        expect([...persistence.values.entries()]).toEqual(beforeValues);
        expect(events).toEqual([]);
        await expect(wakeScheduler.read(ctx, agentId)).resolves.toEqual({
            state: "cancelled",
            agentId,
            operationId: "schedulerless-changed-pause",
        });
    });

    it("binds external wake message identities to each lifecycle", async () => {
        const persistence = new SerializedGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            clock: () => 1,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });

        await goals.setGoal(ctx, "wake-agent", "repeat the objective", {
            operationId: "wake-lifecycle-one",
        });
        await goals.changeGoalStatus(ctx, "wake-agent", "paused", {
            operationId: "pause-lifecycle-one",
        });
        await goals.changeGoalStatus(ctx, "wake-agent", "active", {
            operationId: "wake-lifecycle-two",
        });
        await goals.clearGoal(ctx, "wake-agent", { operationId: "clear-lifecycle-two" });
        await goals.setGoal(ctx, "wake-agent", "repeat the objective", {
            operationId: "wake-lifecycle-three",
        });

        const sentIds = wakeScheduler.requests.flatMap((request) =>
            request.state === "scheduled" ? [request.messageId] : [],
        );
        expect(sentIds).toHaveLength(3);
        expect(new Set(sentIds).size).toBe(3);
    });

    it("durably cancels pending wakes for every inactive transition and clear", async () => {
        const persistence = new InMemoryPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });
        const agentId = "wake-cancellation-agent";

        await goals.setGoal(ctx, agentId, "first", { operationId: "wake-first" });
        await goals.changeGoalStatus(ctx, agentId, "blocked", {
            operationId: "cancel-blocked",
        });
        await goals.changeGoalStatus(ctx, agentId, "active", { operationId: "wake-second" });
        await goals.changeGoalStatus(ctx, agentId, "complete", {
            operationId: "cancel-complete",
        });
        await goals.setGoal(ctx, agentId, "third", { operationId: "wake-third" });
        await goals.clearGoal(ctx, agentId, { operationId: "cancel-clear" });

        expect(wakeScheduler.requests.map((request) => request.state)).toEqual([
            "scheduled",
            "cancelled",
            "scheduled",
            "cancelled",
            "scheduled",
            "cancelled",
        ]);
        await expect(wakeScheduler.read(ctx, agentId)).resolves.toEqual({
            state: "cancelled",
            agentId,
            operationId: "cancel-clear",
        });
    });

    it("fails closed when a restarted host cannot cancel an external activation", async () => {
        const persistence = new InMemoryPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const storage = goalStorageOfPersistence(persistence);
        const configured = new GoalFeature({ afterCommit, storage, wakeScheduler });
        const agentId = "missing-cancellation-scheduler-agent";
        await configured.setGoal(ctx, agentId, "ship the thing", {
            operationId: "scheduled-before-restart",
        });
        const restarted = new BaseGoalFeature({ afterCommit, storage });

        await expect(
            restarted.changeGoalStatus(ctx, agentId, "paused", {
                operationId: "pause-without-scheduler",
            }),
        ).rejects.toThrow("Superseding an external Goal activation requires");
        await expect(configured.goal(ctx, agentId)).resolves.toMatchObject({ status: "active" });
        await expect(wakeScheduler.read(ctx, agentId)).resolves.toMatchObject({
            state: "scheduled",
            lifecycleId: "scheduled-before-restart",
        });
    });

    it("schedules the complete maximum escaped objective within its exact prompt bound", async () => {
        const persistence = new InMemoryPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });
        const objective = "&".repeat(MAX_GOAL_OBJECTIVE_CHARS);

        await expect(
            goals.setGoal(ctx, "escaped-objective-agent", objective, {
                operationId: "escaped-objective-operation",
            }),
        ).resolves.toMatchObject({ objective, status: "active" });

        const state = await wakeScheduler.read(ctx, "escaped-objective-agent");
        if (state?.state !== "scheduled") throw new Error("Missing scheduled Goal wake.");
        expect(state.prompt.length).toBeLessThanOrEqual(MAX_GOAL_CONTINUATION_PROMPT_CHARS);
        expect(state.prompt).toContain("&amp;".repeat(MAX_GOAL_OBJECTIVE_CHARS));
        expect(state.prompt).not.toContain(`\n${objective}\n`);

        const nulPersistence = new InMemoryPersistence();
        const nulScheduler = new TransactionalGoalWakeScheduler(nulPersistence);
        const nulGoals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(nulPersistence),
            wakeScheduler: nulScheduler,
        });
        const nulObjective = "\0".repeat(MAX_GOAL_OBJECTIVE_CHARS);
        await expect(
            nulGoals.setGoal(ctx, "nul-objective-agent", nulObjective, {
                operationId: "nul-objective-operation",
            }),
        ).resolves.toMatchObject({ objective: nulObjective, status: "active" });
        const nulState = await nulScheduler.read(ctx, "nul-objective-agent");
        expect(Buffer.byteLength(JSON.stringify(nulState), "utf8")).toBeLessThanOrEqual(
            MAX_GOAL_WAKE_STATE_BYTES,
        );
    });

    it("rejects schema-valid substituted and in-place-mutated transaction wake results", async () => {
        const persistence = new HostileTransactionPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "hostile-transaction-agent";

        await goals.setGoal(ctx, agentId, "ship the thing", { operationId: "set-hostile-base" });

        persistence.mode = "substitute";
        await expect(
            goals.changeGoalStatus(ctx, agentId, "paused", { operationId: "pause-substituted" }),
        ).rejects.toThrow("different from its decision");
        expect((await goals.goal(ctx, agentId))?.status).toBe("paused");

        persistence.mode = "mutate";
        await expect(
            goals.changeGoalStatus(ctx, agentId, "active", { operationId: "resume-mutated" }),
        ).rejects.toThrow("different from its decision");
        expect((await goals.goal(ctx, agentId))?.status).toBe("active");
    });

    it("rolls back when a transactional observer reinserts the goal after clear", async () => {
        const persistence = new InMemoryPersistence();
        const storage = goalStorageOfPersistence(persistence);
        const agentId = "clear-reinsert-agent";
        const scope = goalScope(persistence, agentId);
        const setup = new GoalFeature({ afterCommit, storage });
        await setup.setGoal(ctx, agentId, "ship the thing", {
            operationId: "clear-reinsert-set",
        });
        const paused = await setup.changeGoalStatus(ctx, agentId, "paused", {
            operationId: "clear-reinsert-pause",
        });
        const hostile = new GoalFeature({
            afterCommit,
            listener: {
                onEventTransactional: async (txCtx, event) => {
                    if (event.type === "goal_cleared") {
                        await persistence.writeValue(
                            txCtx,
                            `${scope.kv.prefix}${GOAL_KEY}`,
                            structuredClone(paused),
                        );
                    }
                },
            },
            storage,
        });

        await expect(
            hostile.clearGoal(ctx, agentId, { operationId: "clear-reinsert-operation" }),
        ).rejects.toThrow("authoritative state");
        await expect(hostile.goal(ctx, agentId)).resolves.toEqual(paused);
        await expect(
            setup.clearGoal(ctx, agentId, { operationId: "clear-reinsert-operation" }),
        ).resolves.toBe(true);
        await expect(setup.goal(ctx, agentId)).resolves.toBeUndefined();
    });

    it("fails closed on a coherent authoritative substitution after the callback returns", async () => {
        const persistence = new AfterCallbackMutationPersistence();
        const agentId = "after-callback-goal-agent";
        const scope = goalScope(persistence, agentId);
        const goals = new GoalFeature({
            afterCommit,
            clock: () => 5,
            storage: goalStorageOfPersistence(persistence),
        });
        const substituted: SessionGoal = {
            createdAt: 5,
            objective: "host substituted objective",
            status: "active",
            updatedAt: 5,
        };
        persistence.mutateAfterTransactions(1, async (txCtx, store) => {
            await store.writeValue(
                txCtx,
                `${scope.kv.prefix}${GOAL_KEY}`,
                structuredClone(substituted),
            );
            await store.writeValue(txCtx, `${scope.kv.prefix}${GOAL_LIFECYCLE_KEY}`, {
                activation: "external",
                id: "after-callback-goal-set",
                goal: structuredClone(substituted),
            });
        });

        await expect(
            goals.setGoal(ctx, agentId, "requested objective", {
                operationId: "after-callback-goal-set",
            }),
        ).rejects.toThrow("does not match the completed transaction decision");
        await expect(goals.goal(ctx, agentId)).resolves.toEqual(substituted);
    });

    it("detects coherent status substitution and post-clear reinsertion after callback return", async () => {
        const statusPersistence = new AfterCallbackMutationPersistence();
        const statusAgentId = "after-callback-status-agent";
        const statusScope = goalScope(statusPersistence, statusAgentId);
        const statusGoals = new GoalFeature({
            afterCommit,
            clock: () => 8,
            storage: goalStorageOfPersistence(statusPersistence),
        });
        const active = await statusGoals.setGoal(ctx, statusAgentId, "ship the thing", {
            operationId: "after-callback-status-set",
        });
        statusPersistence.mutateAfterTransactions(1, async (txCtx, store) => {
            await store.writeValue(
                txCtx,
                `${statusScope.kv.prefix}${GOAL_KEY}`,
                structuredClone(active),
            );
            await store.writeValue(txCtx, `${statusScope.kv.prefix}${GOAL_LIFECYCLE_KEY}`, {
                activation: "external",
                id: "after-callback-status-set",
                goal: structuredClone(active),
            });
            await store.writeValue(
                txCtx,
                `${statusScope.kv.prefix}${GOAL_AUTO_BLOCK_OPERATION_ID_KEY}`,
                expectedAutomaticBlockId("after-callback-status-set"),
            );
        });

        await expect(
            statusGoals.changeGoalStatus(ctx, statusAgentId, "paused", {
                operationId: "after-callback-status-pause",
            }),
        ).rejects.toThrow("does not match the completed transaction decision");
        await expect(statusGoals.goal(ctx, statusAgentId)).resolves.toEqual(active);

        const clearPersistence = new AfterCallbackMutationPersistence();
        const clearAgentId = "after-callback-clear-agent";
        const clearScope = goalScope(clearPersistence, clearAgentId);
        const clearGoals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(clearPersistence),
        });
        await clearGoals.setGoal(ctx, clearAgentId, "ship the thing", {
            operationId: "after-callback-clear-set",
        });
        const paused = await clearGoals.changeGoalStatus(ctx, clearAgentId, "paused", {
            operationId: "after-callback-clear-pause",
        });
        clearPersistence.mutateAfterTransactions(1, async (txCtx, store) => {
            await store.writeValue(
                txCtx,
                `${clearScope.kv.prefix}${GOAL_KEY}`,
                structuredClone(paused),
            );
        });

        await expect(
            clearGoals.clearGoal(ctx, clearAgentId, {
                operationId: "after-callback-clear-operation",
            }),
        ).rejects.toThrow("does not match the completed transaction decision");
        await expect(clearGoals.goal(ctx, clearAgentId)).resolves.toEqual(paused);
    });

    it("detects a coherent immutable-evidence substitution after callback return", async () => {
        const persistence = new AfterCallbackMutationPersistence();
        const agentId = "after-callback-evidence-agent";
        const scope = goalScope(persistence, agentId);
        const goals = new GoalFeature({
            afterCommit,
            clock: () => 11,
            storage: goalStorageOfPersistence(persistence),
        });
        persistence.mutateAfterTransactions(1, async (txCtx, store) => {
            const key = `${scope.kv.prefix}${GOAL_OPERATIONS_KEY}`;
            const entry = (await store.readValues(txCtx, key)).find(
                (candidate) => candidate.key === key,
            );
            if (!Array.isArray(entry?.value) || entry.value.length !== 1) {
                throw new Error("Missing staged Goal operation evidence.");
            }
            const [evidence] = structuredClone(entry.value) as [
                {
                    receipt: { result: { goal: SessionGoal } };
                    proof: { result: { goal: SessionGoal } };
                },
            ];
            evidence.receipt.result.goal.createdAt = 12;
            evidence.receipt.result.goal.updatedAt = 12;
            evidence.proof.result.goal.createdAt = 12;
            evidence.proof.result.goal.updatedAt = 12;
            await store.writeValue(txCtx, key, [evidence]);
        });

        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "after-callback-evidence-set",
            }),
        ).rejects.toThrow("does not match the completed transaction decision");
        await expect(goals.goal(ctx, agentId)).resolves.toMatchObject({
            objective: "ship the thing",
            status: "active",
        });
    });

    it("detects run-state substitution after both lifecycle observation callbacks", async () => {
        const beforePersistence = new AfterCallbackMutationPersistence();
        const beforeAgentId = "after-callback-before-loop-agent";
        const beforeScope = goalScope(beforePersistence, beforeAgentId);
        const beforeGoals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(beforePersistence),
        });
        await beforeGoals.setGoal(ctx, beforeAgentId, "ship the thing", {
            operationId: "after-callback-before-loop-set",
        });
        beforePersistence.mutateAfterTransactions(1, async (txCtx, store) => {
            await store.writeValue(
                txCtx,
                `${beforeScope.runKV.prefix}${GOAL_OBSERVED_LIFECYCLE_ID_KEY}`,
                "substituted-observed-lifecycle",
            );
            await store.writeValue(
                txCtx,
                `${beforeScope.runKV.prefix}${GOAL_CONTINUATION_ID_KEY}`,
                "gsubstitutedcontinuation",
            );
        });

        await expect(beforeGoals.beforeAgentLoop(ctx, beforeScope)).rejects.toThrow(
            "loop state does not match",
        );

        const toolPersistence = new AfterCallbackMutationPersistence();
        const toolAgentId = "after-callback-tool-observation-agent";
        const toolScope = goalScope(toolPersistence, toolAgentId);
        const call = goalToolCall(toolPersistence, toolAgentId, "observation-call");
        const toolGoals = new GoalFeature({
            afterCommit,
            idFactory: () => "tool-observation-operation",
            storage: goalStorageOfPersistence(toolPersistence),
        });
        toolPersistence.mutateAfterTransactions(3, async (txCtx, store) => {
            await store.writeValue(
                txCtx,
                `${toolScope.runKV.prefix}${GOAL_OBSERVED_LIFECYCLE_ID_KEY}`,
                "substituted-tool-observation",
            );
        });

        await expect(
            requiredGoalTool(toolGoals, toolScope, "create_goal").execute(call.executeCtx, {
                objective: "ship the thing",
            }),
        ).rejects.toThrow("loop state does not match");
        await expect(toolGoals.goal(ctx, toolAgentId)).resolves.toMatchObject({
            objective: "ship the thing",
            status: "active",
        });
    });

    it("detects an automatic-block sidecar mutation after the callback returns", async () => {
        const persistence = new AfterCallbackMutationPersistence();
        const agentId = "after-callback-auto-block-agent";
        const scope = goalScope(persistence, agentId);
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "after-callback-auto-block-set",
        });
        await goals.beforeAgentLoop(ctx, scope);
        await goals.afterInference(ctx, scope, {
            state: "error",
            tokens: { input: 0, output: 0 },
        });
        await scope.kv.write(ctx, GOAL_FAILURE_COUNT_KEY, 2);
        persistence.mutateAfterTransactions(1, async (txCtx, store) => {
            await store.writeValue(txCtx, `${scope.kv.prefix}${GOAL_FAILURE_COUNT_KEY}`, 1);
        });

        await expect(goals.afterAgentLoop(ctx, scope)).rejects.toThrow(
            "inactive Goal retains active-lifecycle state",
        );
        await expect(goals.goal(ctx, agentId)).rejects.toThrow(
            "inactive Goal retains active-lifecycle state",
        );
    });

    it("detects scheduler substitution after its in-transaction readback", async () => {
        const persistence = new AfterCallbackMutationPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const agentId = "after-callback-wake-agent";
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });
        persistence.mutateAfterTransactions(1, async (txCtx, store) => {
            const key = `goal-wake.${agentId}`;
            const entry = (await store.readValues(txCtx, key)).find(
                (candidate) => candidate.key === key,
            );
            if (entry === undefined || !Value.Check(goalWakeStateSchema, entry.value)) {
                throw new Error("Missing staged Goal wake state.");
            }
            if (entry.value.state !== "scheduled") {
                throw new Error("Expected a scheduled Goal wake.");
            }
            await store.writeValue(txCtx, key, {
                ...entry.value,
                messageId: "gsubstitutedafterreadback",
            });
        });

        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "after-callback-wake-set",
            }),
        ).rejects.toThrow("did not retain the requested latest state");
        await expect(wakeScheduler.read(ctx, agentId)).resolves.toMatchObject({
            state: "scheduled",
            messageId: "gsubstitutedafterreadback",
        });

        const cancelPersistence = new AfterCallbackMutationPersistence();
        const cancelScheduler = new TransactionalGoalWakeScheduler(cancelPersistence);
        const cancelAgentId = "after-callback-cancel-agent";
        const cancelGoals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(cancelPersistence),
            wakeScheduler: cancelScheduler,
        });
        await cancelGoals.setGoal(ctx, cancelAgentId, "ship the thing", {
            operationId: "after-callback-cancel-set",
        });
        cancelPersistence.mutateAfterTransactions(1, async (txCtx, store) => {
            const key = `goal-wake.${cancelAgentId}`;
            const entry = (await store.readValues(txCtx, key)).find(
                (candidate) => candidate.key === key,
            );
            if (entry === undefined || !Value.Check(goalWakeStateSchema, entry.value)) {
                throw new Error("Missing staged Goal wake cancellation.");
            }
            if (entry.value.state !== "cancelled") {
                throw new Error("Expected a cancelled Goal wake.");
            }
            await store.writeValue(txCtx, key, {
                ...entry.value,
                operationId: "substituted-cancel-operation",
            });
        });

        await expect(
            cancelGoals.changeGoalStatus(ctx, cancelAgentId, "paused", {
                operationId: "after-callback-cancel-pause",
            }),
        ).rejects.toThrow("did not retain the requested latest state");
        await expect(cancelScheduler.read(ctx, cancelAgentId)).resolves.toEqual({
            state: "cancelled",
            agentId: cancelAgentId,
            operationId: "substituted-cancel-operation",
        });
    });

    it("replays a durable operation across fresh feature instances and rejects altered input", async () => {
        const world = agentWorld();
        const firstFeature = new GoalFeature({ afterCommit, storage: goalStorage(world.storage) });
        const first = await firstFeature.setGoal(ctx, "agent-1", "ship the thing", {
            operationId: "durable-set",
        });
        const restarted = new GoalFeature({ afterCommit, storage: goalStorage(world.storage) });

        await expect(
            restarted.setGoal(ctx, "agent-1", "ship the thing", { operationId: "durable-set" }),
        ).resolves.toEqual(first);
        await expect(
            restarted.setGoal(ctx, "agent-1", "ship another thing", {
                operationId: "durable-set",
            }),
        ).rejects.toThrow("receipt");
    });

    it("rejects a schema-valid tampered receipt using the independent proof", async () => {
        const world = agentWorld();
        const goals = new GoalFeature({ afterCommit, storage: goalStorage(world.storage) });
        await goals.setGoal(ctx, "agent-1", "ship the thing", { operationId: "tampered" });
        const store = world.stores.get("agent-1");
        if (store === undefined) throw new Error("Missing agent store.");
        const ledgerKey = [...store.values.keys()].find((key) => key.endsWith("operations"));
        if (ledgerKey === undefined) throw new Error("Missing goal operation ledger.");
        const ledger = store.values.get(ledgerKey);
        if (!Array.isArray(ledger) || ledger.length !== 1 || ledger[0]?.receipt === undefined) {
            throw new Error("Invalid receipt fixture.");
        }
        store.values.set(ledgerKey, [
            {
                ...ledger[0],
                receipt: {
                    ...ledger[0].receipt,
                    result: {
                        operation: "set",
                        changed: true,
                        goal: {
                            createdAt: 1,
                            objective: "tampered",
                            status: "active",
                            updatedAt: 1,
                        },
                    },
                },
            },
        ]);
        await expect(
            goals.setGoal(ctx, "agent-1", "ship the thing", { operationId: "tampered" }),
        ).rejects.toThrow("proof");
    });

    it("rejects malformed Goal timestamps and active-only sidecars on every load", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "malformed-state-agent";
        const scope = goalScope(persistence, agentId);
        const goal = await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "malformed-state-set",
        });
        const goalKey = `${scope.kv.prefix}${GOAL_KEY}`;
        const lifecycleKey = `${scope.kv.prefix}${GOAL_LIFECYCLE_KEY}`;

        persistence.values.set(goalKey, { ...goal, updatedAt: goal.createdAt - 1 });
        await expect(goals.goal(ctx, agentId)).rejects.toThrow("invalid timestamps");
        await expect(
            goals.clearGoal(ctx, agentId, { operationId: "malformed-state-clear" }),
        ).rejects.toThrow("invalid timestamps");

        const paused = { ...goal, status: "paused" as const };
        persistence.values.set(goalKey, paused);
        persistence.values.set(lifecycleKey, {
            activation: "external",
            id: "malformed-state-set",
            goal: paused,
        });
        await expect(goals.goal(ctx, agentId)).rejects.toThrow(
            "inactive Goal retains active-lifecycle state",
        );

        persistence.values.delete(goalKey);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow(
            "inactive Goal retains active-lifecycle state",
        );
    });

    it("rejects schema-valid illegal failure counts and substituted lifecycle snapshots", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const agentId = "malformed-active-sidecar-agent";
        const scope = goalScope(persistence, agentId);
        const goal = await goals.setGoal(ctx, agentId, "ship the thing", {
            operationId: "malformed-active-set",
        });

        await scope.kv.write(ctx, GOAL_FAILURE_COUNT_KEY, 0);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow("failure count is invalid");
        await scope.kv.write(ctx, GOAL_FAILURE_COUNT_KEY, 3);
        await expect(goals.goal(ctx, agentId)).rejects.toThrow("failure count is invalid");
        await scope.kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);

        await scope.kv.write(ctx, GOAL_LIFECYCLE_KEY, {
            activation: "external",
            id: "malformed-active-set",
            goal: { ...goal, objective: "substituted objective" },
        });
        await expect(goals.goal(ctx, agentId)).rejects.toThrow("exact lifecycle sidecar");
    });

    it("recomputes fingerprints and proof transitions for host, call, and automatic evidence", async () => {
        const persistence = new InMemoryPersistence();
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(persistence),
        });
        const hostAgentId = "malformed-host-proof-agent";
        await goals.setGoal(ctx, hostAgentId, "host objective", {
            operationId: "host-proof-operation",
        });
        const ledgerKey = goalLedgerKey(persistence);
        const ledger = persistence.values.get(ledgerKey);
        if (!Array.isArray(ledger) || ledger.length !== 1) {
            throw new Error("Missing host Goal evidence.");
        }
        const hostEvidence = structuredClone(ledger[0]) as {
            proof: { input: { objective: string } };
        };
        hostEvidence.proof.input.objective = "fingerprint substitution";
        persistence.values.set(ledgerKey, [hostEvidence]);
        await expect(goals.goal(ctx, hostAgentId)).rejects.toThrow("fingerprint");

        const callPersistence = new InMemoryPersistence();
        const callGoals = new GoalFeature({
            afterCommit,
            idFactory: () => "call-proof-operation",
            storage: goalStorageOfPersistence(callPersistence),
        });
        const callAgentId = "malformed-call-proof-agent";
        const call = goalToolCall(callPersistence, callAgentId, "malformed-proof-call");
        const tool = requiredGoalTool(
            callGoals,
            goalScope(callPersistence, callAgentId),
            "create_goal",
        );
        await tool.execute(call.executeCtx, { objective: "call objective" });
        const callEvidence = await call.kv.read(ctx, "operation");
        if (
            typeof callEvidence !== "object" ||
            callEvidence === null ||
            !Object.hasOwn(callEvidence, "receipt") ||
            !Object.hasOwn(callEvidence, "proof")
        ) {
            throw new Error("Missing call Goal evidence.");
        }
        const malformedCall = structuredClone(callEvidence) as {
            receipt: { result: { goal: SessionGoal } };
            proof: { result: { goal: SessionGoal } };
        };
        malformedCall.receipt.result.goal.updatedAt =
            malformedCall.receipt.result.goal.createdAt - 1;
        malformedCall.proof.result.goal.updatedAt = malformedCall.proof.result.goal.createdAt - 1;
        await call.kv.write(ctx, "operation", malformedCall);
        await expect(
            tool.execute(call.executeCtx, { objective: "call objective" }),
        ).rejects.toThrow("invalid timestamps");

        const autoPersistence = new InMemoryPersistence();
        const autoGoals = new GoalFeature({
            afterCommit,
            storage: goalStorageOfPersistence(autoPersistence),
        });
        const autoAgentId = "malformed-auto-proof-agent";
        const autoScope = goalScope(autoPersistence, autoAgentId);
        await autoGoals.setGoal(ctx, autoAgentId, "automatic objective", {
            operationId: "automatic-proof-set",
        });
        await autoGoals.beforeAgentLoop(ctx, autoScope);
        await autoGoals.afterInference(ctx, autoScope, {
            state: "error",
            tokens: { input: 0, output: 0 },
        });
        await autoScope.kv.write(ctx, GOAL_FAILURE_COUNT_KEY, 2);
        await autoGoals.afterAgentLoop(ctx, autoScope);
        const automaticKey = `${autoScope.kv.prefix}${GOAL_AUTO_BLOCK_EVIDENCE_KEY}`;
        const automatic = autoPersistence.values.get(automaticKey);
        if (
            typeof automatic !== "object" ||
            automatic === null ||
            !Object.hasOwn(automatic, "proof")
        ) {
            throw new Error("Missing automatic Goal evidence.");
        }
        const malformedAutomatic = structuredClone(automatic) as {
            proof: { before: SessionGoal };
        };
        malformedAutomatic.proof.before.status = "paused";
        autoPersistence.values.set(automaticKey, malformedAutomatic);
        await expect(autoGoals.goal(ctx, autoAgentId)).rejects.toThrow("automatic-block proof");
    });

    it("delivers one deeply frozen event only after the outermost transaction commits", async () => {
        const persistence = new OutermostCommitGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        let transactional: GoalEvent | undefined;
        let committed: GoalEvent | undefined;
        let committedRead: SessionGoal | undefined;
        const goals = new GoalFeature({
            afterCommit: persistence.afterCommit,
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional = event;
                    expect(Object.isFrozen(event)).toBe(true);
                },
                onEvent: async (postCommitCtx, event) => {
                    committed = event;
                    committedRead = await goals.goal(postCommitCtx, "outer-commit-agent");
                    expect(Object.isFrozen(event)).toBe(true);
                },
            },
        });

        await persistence.transaction(ctx, async (outerCtx) => {
            await goals.setGoal(outerCtx, "outer-commit-agent", "ship the thing", {
                operationId: "outer-commit-set",
            });
            expect(transactional).toBeDefined();
            expect(committed).toBeUndefined();
            await expect(goals.goal(ctx, "outer-commit-agent")).resolves.toBeUndefined();
        });

        expect(committed).toBe(transactional);
        expect(committedRead?.objective).toBe("ship the thing");
    });

    it("publishes no post-commit event and retains no effects after an outer rollback", async () => {
        const persistence = new OutermostCommitGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const transactional: GoalEvent[] = [];
        const committed: GoalEvent[] = [];
        const goals = new GoalFeature({
            afterCommit: persistence.afterCommit,
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    transactional.push(event);
                },
                onEvent: (_eventCtx, event) => {
                    committed.push(event);
                },
            },
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });

        await expect(
            persistence.transaction(ctx, async (outerCtx) => {
                await goals.setGoal(outerCtx, "outer-rollback-agent", "ship the thing", {
                    operationId: "outer-rollback-set",
                });
                expect(transactional).toHaveLength(1);
                expect(committed).toEqual([]);
                throw new Error("roll back the host transaction");
            }),
        ).rejects.toThrow("roll back the host transaction");

        expect(transactional).toHaveLength(1);
        expect(committed).toEqual([]);
        expect(persistence.values.size).toBe(0);
        await expect(goals.goal(ctx, "outer-rollback-agent")).resolves.toBeUndefined();
        await expect(wakeScheduler.read(ctx, "outer-rollback-agent")).resolves.toBeUndefined();
    });

    it("contains hostile post-commit failures and bounded reporter failures after commit", async () => {
        const persistence = new OutermostCommitGoalPersistence();
        const wakeScheduler = new TransactionalGoalWakeScheduler(persistence);
        const reported: string[] = [];
        let deliveries = 0;
        const goals = new GoalFeature({
            afterCommit: persistence.afterCommit,
            listener: {
                onEvent: () => {
                    deliveries += 1;
                    if (deliveries === 1) throw new Error("x".repeat(1_000));
                    throw Object.create(null);
                },
            },
            onPostCommitError: (_errorCtx, _event, message) => {
                reported.push(message);
                throw Object.create(null);
            },
            storage: goalStorageOfPersistence(persistence),
            wakeScheduler,
        });
        const agentId = "hostile-post-commit-agent";

        await expect(
            goals.setGoal(ctx, agentId, "ship the thing", {
                operationId: "hostile-post-commit-set",
            }),
        ).resolves.toMatchObject({ status: "active" });
        await expect(
            goals.changeGoalStatus(ctx, agentId, "paused", {
                operationId: "hostile-post-commit-pause",
            }),
        ).resolves.toMatchObject({ status: "paused" });

        expect(reported).toEqual(["x".repeat(500), "Unknown Goal observer error."]);
        await expect(goals.goal(ctx, agentId)).resolves.toMatchObject({ status: "paused" });
    });

    it("rolls back when afterCommit registration is malformed", async () => {
        const goals = new GoalFeature({
            afterCommit: () => Promise.resolve(),
            storage: goalStorage(agentWorld().storage),
        });
        await expect(goals.setGoal(ctx, "agent-1", "ship the thing")).rejects.toThrow(
            "synchronously",
        );
        await expect(goals.goal(ctx, "agent-1")).resolves.toBeUndefined();
    });
});

function expectedAutomaticBlockId(lifecycleId: unknown): string {
    if (typeof lifecycleId !== "string") throw new Error("Missing Goal lifecycle ID.");
    return `b${createHash("sha256")
        .update(JSON.stringify(["goal-auto-block", lifecycleId]), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
}

function lifecycleId(value: unknown): string {
    if (
        typeof value !== "object" ||
        value === null ||
        !Object.hasOwn(value, "id") ||
        typeof (value as { id?: unknown }).id !== "string"
    ) {
        throw new Error("Missing Goal lifecycle sidecar.");
    }
    return (value as { id: string }).id;
}

function goalLedgerKey(persistence: InMemoryPersistence): string {
    const key = [...persistence.values.keys()].find((candidate) =>
        candidate.endsWith(".operations"),
    );
    if (key === undefined) throw new Error("Missing Goal operation ledger.");
    return key;
}

function goalLedgerOperationIds(persistence: InMemoryPersistence): readonly string[] {
    const ledger = persistence.values.get(goalLedgerKey(persistence));
    if (!Array.isArray(ledger)) throw new Error("Missing Goal operation ledger.");
    return ledger.map((entry: { receipt?: { operationId?: string } }) => {
        const operationId = entry.receipt?.operationId;
        if (operationId === undefined) throw new Error("Missing Goal operation receipt.");
        return operationId;
    });
}

function goalEvidence(agentId: string, operationId: string, goal: SessionGoal) {
    const result = {
        operation: "status" as const,
        changed: false,
        goal: structuredClone(goal),
    };
    const shared = {
        operation: "status" as const,
        agentId,
        operationId,
        fingerprint: createHash("sha256")
            .update(
                JSON.stringify({
                    agentId,
                    input: { status: goal.status },
                    operation: "status",
                }),
                "utf8",
            )
            .digest("hex"),
        result,
        createdAt: 1,
    };
    return {
        receipt: structuredClone(shared),
        proof: {
            ...structuredClone(shared),
            input: { status: goal.status },
            before: structuredClone(goal),
        },
    };
}
