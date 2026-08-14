import { Value } from "@sinclair/typebox/value";
import {
    AgentKV,
    withAgentKV,
    type AgentPersistence,
    type AgentRecord,
} from "@slopus/happy-agent-base";
import { createContextNamespace, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    assertTasksFeatureOptions,
    TasksFeature,
    tasksFeatureOptionsSchema,
} from "../../sources/tasks/TasksFeature.js";
import type { TaskEvent } from "../../sources/tasks/TaskEvent.js";
import { taskSchema } from "../../sources/tasks/Task.js";
import { assertTaskPersistence, taskPersistenceSchema } from "../../sources/tasks/TaskStore.js";
import { agentWorld } from "../support/agentWorld.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const ctx = createRootContext().named("happy-agent-features-tasks");

const nestedTransactionNamespace = createContextNamespace<NestedTransactionState | undefined>(
    "tasksNestedTransactionTest",
    undefined,
);

interface NestedTransactionState {
    readonly callbacks: Array<(postCommitCtx: Context) => void | Promise<void>>;
}

class SerializingPersistence implements AgentPersistence {
    readonly #inner = new InMemoryPersistence();
    #tail = Promise.resolve();

    async transaction<Result>(
        context: Context,
        work: (transactionContext: Context) => Promise<Result>,
    ): Promise<Result> {
        const previous = this.#tail;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#tail = previous.then(() => current);
        await previous;
        try {
            return await this.#inner.transaction(context, work);
        } finally {
            release();
        }
    }

    load(context: Context): Promise<readonly AgentRecord[]> {
        void context;
        return this.#inner.load();
    }

    append(context: Context, record: AgentRecord): Promise<void> {
        return this.#inner.append(context, record);
    }

    clearRecords(context: Context): Promise<void> {
        return this.#inner.clearRecords(context);
    }

    readValues(
        context: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return this.#inner.readValues(context, prefix);
    }

    writeValue(context: Context, key: string, value: unknown): Promise<void> {
        return this.#inner.writeValue(context, key, value);
    }

    writeValueIfAbsent(context: Context, key: string, value: unknown): Promise<boolean> {
        return this.#inner.writeValueIfAbsent(context, key, value);
    }

    deleteValue(context: Context, key: string): Promise<void> {
        return this.#inner.deleteValue(context, key);
    }
}

class NestedPersistence implements AgentPersistence {
    readonly #inner = new InMemoryPersistence();
    nestedTransactions = 0;

    async transaction<Result>(
        context: Context,
        work: (transactionContext: Context) => Promise<Result>,
    ): Promise<Result> {
        const active = nestedTransactionNamespace.get(context);
        if (active !== undefined) {
            this.nestedTransactions += 1;
            return await work(context);
        }

        const state: NestedTransactionState = { callbacks: [] };
        try {
            const result = await this.#inner.transaction(
                context,
                async (transactionContext) =>
                    await work(nestedTransactionNamespace.set(transactionContext, state)),
            );
            for (const callback of state.callbacks) await callback(context);
            return result;
        } catch (error) {
            state.callbacks.length = 0;
            throw error;
        }
    }

    load(context: Context): Promise<readonly AgentRecord[]> {
        void context;
        return this.#inner.load();
    }

    append(context: Context, record: AgentRecord): Promise<void> {
        return this.#inner.append(context, record);
    }

    clearRecords(context: Context): Promise<void> {
        return this.#inner.clearRecords(context);
    }

    readValues(
        context: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return this.#inner.readValues(context, prefix);
    }

    writeValue(context: Context, key: string, value: unknown): Promise<void> {
        return this.#inner.writeValue(context, key, value);
    }

    writeValueIfAbsent(context: Context, key: string, value: unknown): Promise<boolean> {
        return this.#inner.writeValueIfAbsent(context, key, value);
    }

    deleteValue(context: Context, key: string): Promise<void> {
        return this.#inner.deleteValue(context, key);
    }
}

function storageFor(world: ReturnType<typeof agentWorld>) {
    return {
        persistence: (agentId: string) => world.storage.persistence(agentId),
    };
}

function deferredCommitBoundary(): {
    readonly callbacks: Array<(postCommitCtx: Context) => void | Promise<void>>;
    readonly afterCommit: (
        txCtx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ) => void;
    readonly flush: () => Promise<void>;
} {
    const callbacks: Array<(postCommitCtx: Context) => void | Promise<void>> = [];
    return {
        callbacks,
        afterCommit: (_txCtx, callback) => {
            callbacks.push(callback);
        },
        flush: async () => {
            const callback = callbacks.shift();
            if (callback === undefined) throw new Error("No post-commit callback is pending.");
            await callback(ctx);
        },
    };
}

function configuredTasks(
    overrides: Partial<ConstructorParameters<typeof TasksFeature>[0]> = {},
): TasksFeature {
    let nextId = 0;
    let now = 1_000;
    const world = agentWorld();
    return new TasksFeature({
        storage: storageFor(world),
        idFactory: () => `generated-${++nextId}`,
        clock: () => ++now,
        afterCommit: () => undefined,
        ...overrides,
    });
}

describe("TasksFeature", () => {
    it("persists one bounded task list and reloads it through a new feature instance", async () => {
        const world = agentWorld();
        let now = 100;
        const first = new TasksFeature({
            storage: storageFor(world),
            clock: () => ++now,
            afterCommit: () => undefined,
        });

        const created = await first.create(ctx, "agent-1", {
            id: "ship",
            title: "  Ship it  ",
            detail: "  Verify the build  ",
            priority: "high",
        });
        expect(created).toMatchObject({
            id: "ship",
            title: "Ship it",
            detail: "Verify the build",
            status: "pending",
            priority: "high",
            ordering: 0,
        });

        const reloaded = new TasksFeature({
            storage: storageFor(world),
            afterCommit: () => undefined,
        });
        expect(await reloaded.get(ctx, "agent-1", "ship")).toEqual(created);
        expect(Value.Check(taskSchema, (await reloaded.list(ctx, "agent-1"))[0])).toBe(true);
    });

    it("keeps public operations and tools on the same durable state", async () => {
        const tasks = configuredTasks();
        const scope = { agent: { id: "agent-1" } } as Parameters<TasksFeature["tools"]>[1];
        const tools = tasks.tools(ctx, scope);
        expect(tools).toHaveLength(5);
        const createTool = tools[0]!;
        const listTool = tools[1]!;
        const getTool = tools[2]!;
        const updateTool = tools[3]!;
        const completeTool = tools[4]!;

        const created = await createTool.execute(ctx, {
            title: "Write tests",
        });
        expect(await tasks.get(ctx, "agent-1", created.task.id)).toEqual(created.task);

        const listed = await listTool.execute(ctx, {});
        expect(listed.tasks).toEqual([created.task]);
        expect(listed.total).toBe(1);
        expect((await getTool.execute(ctx, { id: created.task.id })).task).toEqual(created.task);

        const updated = await updateTool.execute(ctx, {
            id: created.task.id,
            title: "Write more tests",
            detail: null,
        });
        expect(await tasks.get(ctx, "agent-1", created.task.id)).toEqual(updated.task);

        const completed = await completeTool.execute(ctx, { id: created.task.id });
        expect(completed.task.status).toBe("completed");
        expect((await tasks.list(ctx, "agent-1"))[0]?.status).toBe("completed");
        expect(createTool.durable).toBe(true);
        expect(listTool.durable).toBe(true);
        expect(updateTool.durable).toBe(true);
        expect(completeTool.durable).toBe(true);
        expect(getTool.durable).toBe(true);
        expect(Value.Check(createTool.parameters, { id: "model-id", title: "No IDs" })).toBe(false);
    });

    it("pages every task and retrieves full detail from a later page", async () => {
        const tasks = configuredTasks({ maxPageSize: 2 });
        for (const id of ["one", "two", "three", "four", "five"]) {
            await tasks.create(ctx, "agent-1", {
                id,
                title: id,
                ...(id === "five" ? { detail: "full later detail" } : {}),
            });
        }
        const first = await tasks.listPage(ctx, "agent-1", { limit: 2 });
        const second = await tasks.listPage(ctx, "agent-1", {
            limit: 2,
            offset: first.nextOffset!,
        });
        const third = await tasks.listPage(ctx, "agent-1", {
            limit: 2,
            offset: second.nextOffset!,
        });
        expect([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)).toEqual([
            "one",
            "two",
            "three",
            "four",
            "five",
        ]);
        expect((await tasks.get(ctx, "agent-1", "five"))?.detail).toBe("full later detail");
    });

    it("keeps every model-visible task ID reachable when long pages hit the output bound", async () => {
        const tasks = configuredTasks({
            maxOutputCharacters: 256,
            maxPageSize: 50,
        });
        const expectedIds: string[] = [];
        for (let index = 0; index < 8; index++) {
            const id = `task-${index}`;
            expectedIds.push(id);
            await tasks.create(ctx, "agent-1", {
                id,
                title: `Title ${index} ${"x".repeat(480)}`,
                detail: "d".repeat(4_000),
            });
        }

        const scope = { agent: { id: "agent-1" } } as Parameters<TasksFeature["tools"]>[1];
        const listTool = tasks.tools(ctx, scope)[1]!;
        const seenIds: string[] = [];
        let offset: number | undefined;
        do {
            const page = await listTool.execute(ctx, {
                ...(offset === undefined ? {} : { offset }),
                limit: 50,
            });
            const modelBlocks = await listTool.toLLM(page);
            const modelText = modelBlocks
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("\n");
            expect(modelText.length).toBeLessThanOrEqual(256);
            for (const task of page.tasks) {
                expect(modelText).toContain(task.id);
                seenIds.push(task.id);
            }
            offset = page.nextOffset;
        } while (offset !== undefined);

        expect(seenIds).toEqual(expectedIds);
    });

    it("traverses bounded detail and dependency pages without hiding their cursors", async () => {
        const tasks = configuredTasks({ maxOutputCharacters: 256 });
        for (const id of ["dependency-a", "dependency-b", "dependency-c"]) {
            await tasks.create(ctx, "agent-1", { id, title: id });
        }
        const detail = "abcdefghij".repeat(400);
        await tasks.create(ctx, "agent-1", {
            id: "large",
            title: "Large task",
            detail,
            dependsOn: ["dependency-a", "dependency-b", "dependency-c"],
        });

        const detailParts: string[] = [];
        let detailOffset: number | undefined;
        do {
            const page = await tasks.getPage(ctx, "agent-1", "large", {
                detailLimit: 100,
                ...(detailOffset === undefined ? {} : { detailOffset }),
                dependencyLimit: 1,
            });
            expect(tasks.formatDetailPageForModel(page).length).toBeLessThanOrEqual(256);
            if (page.task === null) throw new Error("The task unexpectedly disappeared.");
            detailParts.push(page.detail);
            detailOffset = page.nextDetailOffset;
        } while (detailOffset !== undefined);
        expect(detailParts.join("")).toBe(detail);

        const dependencyParts: string[] = [];
        let dependencyOffset: number | undefined;
        do {
            const page = await tasks.getPage(ctx, "agent-1", "large", {
                detailLimit: 1,
                ...(dependencyOffset === undefined ? {} : { dependencyOffset }),
                dependencyLimit: 1,
            });
            expect(tasks.formatDetailPageForModel(page).length).toBeLessThanOrEqual(256);
            if (page.task === null) throw new Error("The task unexpectedly disappeared.");
            dependencyParts.push(...page.dependencies);
            dependencyOffset = page.nextDependencyOffset;
        } while (dependencyOffset !== undefined);
        expect(dependencyParts).toEqual(["dependency-a", "dependency-b", "dependency-c"]);
    });

    it("keeps max-length dependency identities visible while detail and dependency cursors advance", async () => {
        const tasks = configuredTasks({ maxOutputCharacters: 256 });
        const taskId = "t".repeat(128);
        const dependencyIds = ["a", "b", "c"].map(
            (prefix) => `${prefix}${"dependency".repeat(13).slice(0, 127)}`,
        );
        for (const id of dependencyIds) {
            await tasks.create(ctx, "agent-1", { id, title: "Dependency" });
        }
        const detail = "abc";
        await tasks.create(ctx, "agent-1", {
            id: taskId,
            title: "Task",
            detail,
            dependsOn: dependencyIds,
        });

        const detailParts: string[] = [];
        const seenDependencies: string[] = [];
        let detailOffset = 0;
        let dependencyOffset = 0;
        for (;;) {
            const page = await tasks.getPage(ctx, "agent-1", taskId, {
                detailOffset,
                detailLimit: 1,
                dependencyOffset,
                dependencyLimit: 1,
            });
            if (page.task === null) throw new Error("The task unexpectedly disappeared.");
            const modelText = tasks.formatDetailPageForModel(page);
            expect(modelText.length).toBeLessThanOrEqual(256);
            detailParts.push(page.detail);
            for (const dependency of page.dependencies) {
                expect(modelText).toContain(dependency);
                seenDependencies.push(dependency);
            }

            const nextDetailOffset = page.nextDetailOffset;
            const nextDependencyOffset = page.nextDependencyOffset;
            if (nextDetailOffset !== undefined) {
                expect(nextDetailOffset).toBeGreaterThan(detailOffset);
            }
            if (nextDependencyOffset !== undefined) {
                expect(nextDependencyOffset).toBeGreaterThan(dependencyOffset);
            }
            if (nextDetailOffset === undefined && nextDependencyOffset === undefined) break;
            detailOffset = nextDetailOffset ?? page.detailTotal;
            dependencyOffset = nextDependencyOffset ?? page.dependencyTotal;
        }

        expect(detailParts.join("")).toBe(detail);
        expect(seenDependencies).toEqual(dependencyIds);
    });

    it("reuses the generated ID when a durable create tool is replayed in one call scope", async () => {
        const world = agentWorld();
        let generated = 0;
        const tasks = new TasksFeature({
            storage: storageFor(world),
            idFactory: () => `generated-${++generated}`,
            afterCommit: () => undefined,
        });
        const scope = { agent: { id: "agent-1" } } as Parameters<TasksFeature["tools"]>[1];
        const createTool = tasks.tools(ctx, scope)[0]!;
        const callCtx = withAgentKV(
            ctx,
            new AgentKV(world.storage.persistence("agent-1"), "kv.agent-1.call.call-1."),
        );

        const first = await createTool.execute(callCtx, { title: "Replay me" });
        const replay = await createTool.execute(callCtx, { title: "Replay me" });

        expect(replay.task).toEqual(first.task);
        expect(generated).toBe(1);
        expect(await tasks.list(ctx, "agent-1")).toHaveLength(1);
    });

    it("validates dependencies, rejects cycles, and protects dependents on removal", async () => {
        const tasks = configuredTasks();
        await tasks.create(ctx, "agent-1", { id: "first", title: "First" });
        await tasks.create(ctx, "agent-1", {
            id: "second",
            title: "Second",
            dependsOn: ["first"],
        });

        await expect(
            tasks.update(ctx, "agent-1", "first", { dependsOn: ["second"] }),
        ).rejects.toThrow("cycle");
        await expect(
            tasks.update(ctx, "agent-1", "first", { dependsOn: ["missing"] }),
        ).rejects.toThrow("does not exist");
        await expect(
            tasks.update(ctx, "agent-1", "first", { dependsOn: ["first"] }),
        ).rejects.toThrow("itself");
        await expect(tasks.remove(ctx, "agent-1", "first")).rejects.toThrow("depends on it");
    });

    it("reorders deterministically and compacts after removal", async () => {
        const tasks = configuredTasks();
        await tasks.create(ctx, "agent-1", { id: "a", title: "A" });
        await tasks.create(ctx, "agent-1", { id: "b", title: "B" });
        await tasks.create(ctx, "agent-1", { id: "c", title: "C" });

        expect(
            (await tasks.reorder(ctx, "agent-1", ["c", "a", "b"])).map((task) => task.id),
        ).toEqual(["c", "a", "b"]);
        expect(await tasks.remove(ctx, "agent-1", "a")).toBe(true);
        const afterRemoval = await tasks.list(ctx, "agent-1");
        expect(afterRemoval.map((task) => [task.id, task.ordering])).toEqual([
            ["c", 0],
            ["b", 1],
        ]);
        expect(afterRemoval[0]?.updatedAt).toBeGreaterThan(afterRemoval[0]?.createdAt ?? 0);
        expect(afterRemoval[1]?.updatedAt).toBeGreaterThan(afterRemoval[1]?.createdAt ?? 0);
        await expect(tasks.reorder(ctx, "agent-1", ["c"])).rejects.toThrow("every current task");
    });

    it("enforces task count and model-output bounds", async () => {
        const tasks = configuredTasks({
            maxTasks: 2,
            maxOutputCharacters: 256,
        });
        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        await tasks.create(ctx, "agent-1", { id: "two", title: "Two" });
        await expect(tasks.create(ctx, "agent-1", { id: "three", title: "Three" })).rejects.toThrow(
            "maximum of 2",
        );
        expect(tasks.formatForModel(await tasks.list(ctx, "agent-1")).length).toBeLessThanOrEqual(
            256,
        );
    });

    it("includes bounded detail and dependencies in model-facing output", async () => {
        const tasks = configuredTasks();
        await tasks.create(ctx, "agent-1", {
            id: "first",
            title: "First",
            detail: "Check the output",
        });
        const second = await tasks.create(ctx, "agent-1", {
            id: "second",
            title: "Second",
            dependsOn: ["first"],
        });

        const modelText = tasks.formatForModel([
            second,
            (await tasks.get(ctx, "agent-1", "first"))!,
        ]);
        expect(modelText).toContain("Depends on: first");
        expect(modelText).toContain("Check the output");
    });

    it("runs transactional listeners before commit and post-commit listeners afterward", async () => {
        const world = agentWorld();
        const events: string[] = [];
        let tasks!: TasksFeature;
        const boundary = deferredCommitBoundary();
        const listener = {
            onEventTransactional: async (_listenerCtx: typeof ctx, event: TaskEvent) => {
                expect(await tasks.list(ctx, "agent-1")).toEqual([]);
                events.push(`tx:${event.type}`);
            },
            onEvent: async (_listenerCtx: typeof ctx, event: TaskEvent) => {
                expect((await tasks.list(ctx, "agent-1")).length).toBe(1);
                events.push(`committed:${event.type}`);
            },
        };
        tasks = new TasksFeature({
            storage: storageFor(world),
            listener,
            afterCommit: boundary.afterCommit,
        });

        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        await boundary.flush();
        expect(events).toEqual(["tx:task_created", "committed:task_created"]);
    });

    it("uses one validated event for transactional and deferred post-commit listeners", async () => {
        const world = agentWorld();
        const boundary = deferredCommitBoundary();
        const transactional: TaskEvent[] = [];
        const committed: TaskEvent[] = [];
        const tasks = new TasksFeature({
            storage: storageFor(world),
            eventIdFactory: () => "event-1",
            clock: () => 42,
            afterCommit: boundary.afterCommit,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    committed.push(event);
                },
            },
        });

        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        expect(committed).toEqual([]);
        expect(boundary.callbacks).toHaveLength(1);
        await boundary.flush();
        expect(committed[0]).toBe(transactional[0]);
        expect(committed[0]).toMatchObject({ eventId: "event-1", at: 42 });
    });

    it("delivers one independent frozen event despite caller and transactional mutations", async () => {
        const world = agentWorld();
        const boundary = deferredCommitBoundary();
        let transactional: TaskEvent | undefined;
        let committed: TaskEvent | undefined;
        const tasks = new TasksFeature({
            storage: storageFor(world),
            afterCommit: boundary.afterCommit,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type !== "task_created") {
                        throw new Error("Expected a task-created event.");
                    }
                    expect(Object.isFrozen(event.task)).toBe(true);
                    expect(Reflect.set(event.task, "title", "mutated")).toBe(false);
                },
                onEvent: (_ctx, event) => {
                    committed = event;
                },
            },
        });

        const created = await tasks.create(ctx, "agent-1", {
            id: "one",
            title: "Original",
        });
        (created as { title: string }).title = "caller mutation";
        await boundary.flush();

        expect(transactional).toBeDefined();
        expect(committed).toBe(transactional);
        if (committed?.type !== "task_created") {
            throw new Error("Expected a committed task-created event.");
        }
        expect(committed.task.title).toBe("Original");
    });

    it("does not publish a callback discarded by the host's outer rollback", async () => {
        const world = agentWorld();
        const boundary = deferredCommitBoundary();
        const committed: TaskEvent[] = [];
        const tasks = new TasksFeature({
            storage: storageFor(world),
            afterCommit: boundary.afterCommit,
            listener: {
                onEvent: (_ctx, event) => {
                    committed.push(event);
                },
            },
        });

        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        boundary.callbacks.length = 0;
        expect(committed).toEqual([]);
    });

    it("keeps nested transaction state and callbacks out of an outer rollback", async () => {
        const persistence = new NestedPersistence();
        const committed: TaskEvent[] = [];
        const tasks = new TasksFeature({
            storage: { persistence: () => persistence },
            afterCommit: (txCtx, callback) => {
                const state = nestedTransactionNamespace.get(txCtx);
                if (state === undefined) throw new Error("Missing outer transaction state.");
                state.callbacks.push(callback);
            },
            listener: {
                onEvent: (_ctx, event) => {
                    committed.push(event);
                },
            },
        });

        await expect(
            persistence.transaction(ctx, async (outerCtx) => {
                await tasks.create(outerCtx, "agent-1", {
                    id: "rolled-back",
                    title: "Rolled back",
                });
                expect(await tasks.list(outerCtx, "agent-1")).toHaveLength(1);
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");

        expect(persistence.nestedTransactions).toBeGreaterThan(0);
        expect(await tasks.list(ctx, "agent-1")).toEqual([]);
        expect(committed).toEqual([]);
    });

    it("serializes concurrent creates through the injected persistence transaction", async () => {
        const persistence = new SerializingPersistence();
        const tasks = new TasksFeature({
            storage: { persistence: () => persistence },
            afterCommit: () => undefined,
        });

        await Promise.all([
            tasks.create(ctx, "agent-1", { id: "first", title: "First" }),
            tasks.create(ctx, "agent-1", { id: "second", title: "Second" }),
        ]);

        expect((await tasks.list(ctx, "agent-1")).map((task) => task.id)).toEqual([
            "first",
            "second",
        ]);
    });

    it("contains post-commit listener failures and reports them after durable state commits", async () => {
        const world = agentWorld();
        const boundary = deferredCommitBoundary();
        const errors: unknown[] = [];
        const tasks = new TasksFeature({
            storage: storageFor(world),
            afterCommit: boundary.afterCommit,
            listener: {
                onEvent: () => {
                    throw new Error("post-commit failed");
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(error);
            },
        });

        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        await boundary.flush();
        expect(await tasks.list(ctx, "agent-1")).toHaveLength(1);
        expect(errors).toHaveLength(1);
    });

    it("emits the same completion event when update transitions a task into completed", async () => {
        const events: TaskEvent[] = [];
        const boundary = deferredCommitBoundary();
        const tasks = configuredTasks({
            afterCommit: boundary.afterCommit,
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
            eventIdFactory: () => `event-${events.length + 1}`,
        });
        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        await boundary.flush();
        await tasks.update(ctx, "agent-1", "one", { status: "completed" });
        await boundary.flush();

        expect(events.map((event) => event.type)).toEqual(["task_created", "task_completed"]);
        expect(events[1]).toMatchObject({
            type: "task_completed",
            task: { status: "completed" },
        });
    });

    it("rolls back task state when the transactional listener rejects", async () => {
        const world = agentWorld();
        const tasks = new TasksFeature({
            storage: storageFor(world),
            afterCommit: () => undefined,
            listener: {
                onEventTransactional: () => {
                    throw new Error("listener refused");
                },
            },
        });

        await expect(tasks.create(ctx, "agent-1", { id: "one", title: "One" })).rejects.toThrow(
            "listener refused",
        );
        expect(await tasks.list(ctx, "agent-1")).toEqual([]);
    });

    it("rejects malformed persisted lists and a fresh configuration with a lower bound", async () => {
        const world = agentWorld();
        const first = new TasksFeature({
            storage: storageFor(world),
            maxTasks: 3,
            afterCommit: () => undefined,
        });
        await first.create(ctx, "agent-1", { id: "one", title: "One" });
        await first.create(ctx, "agent-1", { id: "two", title: "Two" });
        await first.create(ctx, "agent-1", { id: "three", title: "Three" });

        const reconfigured = new TasksFeature({
            storage: storageFor(world),
            maxTasks: 2,
            afterCommit: () => undefined,
        });
        await expect(reconfigured.list(ctx, "agent-1")).rejects.toThrow("bounds");

        const persistence = world.stores.get("agent-1");
        if (persistence === undefined) throw new Error("The test store was not created.");
        persistence.values.set("kv.agent-1.feature.tasks.items", [
            {
                id: "broken",
                title: "Broken",
                status: "pending",
                priority: "normal",
                dependsOn: [],
                createdAt: 1,
                updatedAt: 1,
                ordering: 2,
            },
        ]);
        await expect(first.list(ctx, "agent-1")).rejects.toThrow("contiguous");

        persistence.values.set("kv.agent-1.feature.tasks.items", [
            {
                id: "same",
                title: "One",
                status: "pending",
                priority: "normal",
                dependsOn: [],
                createdAt: 1,
                updatedAt: 1,
                ordering: 0,
            },
            {
                id: "same",
                title: "Two",
                status: "pending",
                priority: "normal",
                dependsOn: [],
                createdAt: 1,
                updatedAt: 1,
                ordering: 1,
            },
        ]);
        await expect(first.list(ctx, "agent-1")).rejects.toThrow("unique");

        persistence.values.set("kv.agent-1.feature.tasks.items", [
            {
                id: "one",
                title: "One",
                status: "pending",
                priority: "normal",
                dependsOn: ["missing"],
                createdAt: 1,
                updatedAt: 1,
                ordering: 0,
            },
        ]);
        await expect(first.list(ctx, "agent-1")).rejects.toThrow("invalid dependency");

        persistence.values.set("kv.agent-1.feature.tasks.items", [
            {
                id: "one",
                title: "One",
                status: "pending",
                priority: "normal",
                dependsOn: ["two"],
                createdAt: 1,
                updatedAt: 1,
                ordering: 0,
            },
            {
                id: "two",
                title: "Two",
                status: "pending",
                priority: "normal",
                dependsOn: ["one"],
                createdAt: 1,
                updatedAt: 1,
                ordering: 1,
            },
        ]);
        await expect(first.list(ctx, "agent-1")).rejects.toThrow("cycle");

        persistence.values.set("kv.agent-1.feature.tasks.items", [
            {
                id: "bad-time",
                title: "Bad time",
                status: "pending",
                priority: "normal",
                dependsOn: [],
                createdAt: 10,
                updatedAt: 9,
                ordering: 0,
            },
        ]);
        await expect(first.list(ctx, "agent-1")).rejects.toThrow("timestamp order");
    });

    it("supports reset through the same transaction boundary", async () => {
        const tasks = configuredTasks();
        await tasks.create(ctx, "agent-1", { id: "one", title: "One" });
        await tasks.create(ctx, "agent-1", { id: "two", title: "Two" });
        expect(await tasks.reset(ctx, "agent-1")).toBe(2);
        expect(await tasks.list(ctx, "agent-1")).toEqual([]);
        expect(await tasks.reset(ctx, "agent-1")).toBe(0);
    });

    it("validates the closed TypeBox options contract, including injected nested services", async () => {
        const world = agentWorld();
        const valid = {
            storage: storageFor(world),
            afterCommit: () => undefined,
        };
        expect(Value.Check(tasksFeatureOptionsSchema, valid)).toBe(true);
        assertTasksFeatureOptions(valid);

        expect(
            () =>
                new TasksFeature({
                    ...valid,
                    unknownOption: true,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new TasksFeature({
                    ...valid,
                    listener: { onEvent: () => undefined, unknownListenerKey: true },
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new TasksFeature({
                    ...valid,
                    storage: {
                        persistence: valid.storage.persistence,
                        unknownStorageKey: true,
                    },
                } as never),
        ).toThrow("options are invalid");
    });

    it("validates the persistence returned by the storage factory before constructing AgentKV", async () => {
        const world = agentWorld();
        const persistence = world.storage.persistence("agent-1");
        expect(() => assertTaskPersistence(persistence)).not.toThrow();
        expect(Value.Check(taskPersistenceSchema, {})).toBe(false);

        const malformedStorage = {
            persistence: () => ({ transaction: () => Promise.resolve() }),
        };
        const tasks = new TasksFeature({
            storage: malformedStorage as never,
            afterCommit: () => undefined,
        });

        await expect(tasks.list(ctx, "agent-1")).rejects.toThrow("invalid agent persistence");
    });

    it("rejects an asynchronous afterCommit registration instead of publishing ambiguously", async () => {
        const world = agentWorld();
        const tasks = new TasksFeature({
            storage: storageFor(world),
            afterCommit: (() => Promise.resolve()) as never,
        });

        await expect(tasks.create(ctx, "agent-1", { id: "one", title: "One" })).rejects.toThrow(
            "afterCommit must register synchronously",
        );
        expect(await tasks.list(ctx, "agent-1")).toEqual([]);
    });

    it("keeps the generated durable ID when the task transaction is retried", async () => {
        const world = agentWorld();
        let generated = 0;
        let rejectOnce = true;
        const tasks = new TasksFeature({
            storage: storageFor(world),
            idFactory: () => `retry-${++generated}`,
            afterCommit: () => undefined,
            listener: {
                onEventTransactional: () => {
                    if (rejectOnce) {
                        rejectOnce = false;
                        throw new Error("retry task mutation");
                    }
                },
            },
        });
        const scope = { agent: { id: "agent-1" } } as Parameters<TasksFeature["tools"]>[1];
        const createTool = tasks.tools(ctx, scope)[0]!;
        const callCtx = withAgentKV(
            ctx,
            new AgentKV(world.storage.persistence("agent-1"), "kv.agent-1.call.call-2."),
        );

        await expect(createTool.execute(callCtx, { title: "Retry me" })).rejects.toThrow(
            "retry task mutation",
        );
        const created = await createTool.execute(callCtx, { title: "Retry me" });
        expect(created.task.id).toBe("retry-1");
        expect(generated).toBe(1);
        expect(await tasks.list(ctx, "agent-1")).toEqual([created.task]);
    });
});
