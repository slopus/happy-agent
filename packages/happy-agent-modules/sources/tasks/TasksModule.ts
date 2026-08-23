import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    taskEventIdSchema,
    taskEventListenerSchema,
    taskEventPayloadSchema,
    taskEventSchema,
    type TaskEvent,
    type TaskEventListener,
    type TaskEventPayload,
} from "./TaskEvent.js";
import {
    taskCreateInputSchema,
    taskActiveFormSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskSchema,
    taskStatusSchema,
    taskTitleSchema,
    taskTimestampSchema,
    taskUpdateInputSchema,
    taskOwnerSchema,
    assertTaskMetadata,
    assertTaskMetadataPatch,
    assertTaskMetadataStructure,
    TaskValidationError,
    type Task,
    type TaskCreateInput,
    type TaskMetadata,
    type TaskMetadataPatch,
    type TaskPriority,
    type TaskUpdateInput,
} from "./Task.js";
import {
    taskPageQuerySchema,
    taskPageSchema,
    type TaskPage,
    type TaskPageQuery,
} from "./TaskPage.js";
import {
    MAX_TASK_DEPENDENCY_PAGE_SIZE,
    MAX_TASK_DETAIL_PAGE_SIZE,
    taskDetailPageSchema,
    taskDetailQuerySchema,
    type TaskDetailPage,
    type TaskDetailQuery,
} from "./TaskDetailPage.js";
import { taskKV } from "./impl/taskKV.js";
import { completeTaskTool } from "./tools/complete_task.js";
import { createTaskTool } from "./tools/create_task.js";
import { getTaskTool } from "./tools/get_task.js";
import { listTasksTool } from "./tools/list_tasks.js";
import { removeTaskTool } from "./tools/remove_task.js";
import { updateTaskTool } from "./tools/update_task.js";

/** The largest list the stored shape will hold, whatever any other bound says. */
export const MAX_TASKS = 500;
/** How many tasks one agent may keep at once. */
export const MAX_TASKS_PER_AGENT = 100;
/** The priority a task gets when its creator does not choose one. */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";
/** The largest page `list_tasks` will return, and its size when the caller asks for none. */
export const MAX_TASK_PAGE_SIZE = 50;
/** The character budget every rendering of a task, page, or lookup is cut to fit. */
export const MAX_TASK_OUTPUT_CHARACTERS = 12_000;

const taskListSchema = Type.Array(taskSchema, { maxItems: MAX_TASKS });
const taskReorderIdsSchema = Type.Array(taskIdSchema, {
    maxItems: MAX_TASKS,
    uniqueItems: true,
});
const agentIdSchema = Type.String({ minLength: 1, maxLength: 256 });

interface TaskChange<Result> {
    readonly result: Result;
    readonly event?: TaskEvent;
}

/**
 * A bounded persistent task list.
 *
 * One instance serves all agents in a collection. Every agent's list is kept under that agent's
 * module-owned table, and each mutation uses the context database transaction as the
 * read-decide-write boundary. The module owns no database, filesystem, or agent lifecycle.
 */
export class TasksModule implements AgentModule {
    readonly name = "tasks";
    readonly migrations = [
        [
            "001-task-state",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_task_state (
                        agent_id TEXT PRIMARY KEY,
                        tasks_json TEXT NOT NULL
                    )`,
                );
            },
        ],
    ] as const;

    /**
     * In-flight mutation queues, one per agent. This is ordering, not state: nothing about a task
     * lives here, and an idle agent leaves no entry behind.
     */
    readonly #mutations = new Map<string, Promise<void>>();
    readonly #transactionalListeners = new Set<TaskEventListener>();
    readonly #listeners = new Set<TaskEventListener>();

    /**
     * Watch changes from inside the transaction that commits them, so a subscriber's own writes
     * land with the task list or not at all — and a subscriber that throws rolls the mutation back.
     *
     * Returns the function that stops the subscription.
     */
    onEventTransactional(listener: TaskEventListener): () => void {
        assertTaskEventListener(listener);
        this.#transactionalListeners.add(listener);
        return () => this.#transactionalListeners.delete(listener);
    }

    /**
     * Watch changes once they are durable. The task list has already committed by the time this
     * runs, so a failure here is reported and never turned into a failed mutation.
     *
     * Returns the function that stops the subscription.
     */
    onEvent(listener: TaskEventListener): () => void {
        assertTaskEventListener(listener);
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Return this agent's tasks in deterministic display order. */
    async list(ctx: Context, agentId: string): Promise<readonly Task[]> {
        this.#assertAgentId(agentId);
        return this.#sort(await this.#read(ctx, agentId));
    }

    /** Return one bounded page; callers can follow nextOffset until every task is visible. */
    async listPage(ctx: Context, agentId: string, query: TaskPageQuery = {}): Promise<TaskPage> {
        this.#assertAgentId(agentId);
        if (query.limit !== undefined && query.limit > MAX_TASK_PAGE_SIZE) {
            throw new Error(`Task page limit cannot exceed ${MAX_TASK_PAGE_SIZE}.`);
        }
        if (!Value.Check(taskPageQuerySchema, query)) {
            throw new Error("Invalid task page query.");
        }
        const limit = query.limit ?? MAX_TASK_PAGE_SIZE;
        const offset = query.offset ?? 0;
        const tasks = await this.#read(ctx, agentId);
        const visibleTasks = tasks.map((task) => taskForTaskList(task, tasks));
        const requestedTasks = visibleTasks.slice(offset, offset + limit);
        const pageTasks = this.#fitModelPage(requestedTasks, offset, tasks.length);
        const page: TaskPage = {
            tasks: pageTasks,
            offset,
            limit,
            total: tasks.length,
            ...(offset + pageTasks.length < tasks.length
                ? { nextOffset: offset + pageTasks.length }
                : {}),
        };
        if (!Value.Check(taskPageSchema, page)) {
            throw new Error("Tasks module created an invalid task page.");
        }
        return page;
    }

    /** Return one task, or undefined when the ID is not present. */
    async get(ctx: Context, agentId: string, taskId: string): Promise<Task | undefined> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        const task = (await this.#read(ctx, agentId)).find((candidate) => candidate.id === taskId);
        return task === undefined ? undefined : structuredClone(task);
    }

    /** Read bounded detail and dependency slices for model-facing lookup pagination. */
    async getPage(
        ctx: Context,
        agentId: string,
        taskId: string,
        query: TaskDetailQuery = {},
    ): Promise<TaskDetailPage> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        if (!Value.Check(taskDetailQuerySchema, query)) {
            throw new Error("Invalid task detail query.");
        }
        const task = await this.get(ctx, agentId, taskId);
        if (task === undefined) return { task: null };

        const detail = task.detail ?? "";
        const detailOffset = query.detailOffset ?? 0;
        const dependencyOffset = query.dependencyOffset ?? 0;
        const detailLimit =
            query.detailLimit ?? Math.min(MAX_TASK_DETAIL_PAGE_SIZE, detail.length || 1);
        const dependencyLimit = query.dependencyLimit ?? MAX_TASK_DEPENDENCY_PAGE_SIZE;
        const page: TaskDetailPage = {
            task,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
            dependencies: task.dependsOn.slice(
                dependencyOffset,
                dependencyOffset + dependencyLimit,
            ),
            dependencyOffset,
            dependencyTotal: task.dependsOn.length,
            ...(dependencyOffset + dependencyLimit < task.dependsOn.length
                ? { nextDependencyOffset: dependencyOffset + dependencyLimit }
                : {}),
        };
        return this.#fitTaskDetailPage(page);
    }

    /** Create one task. An existing ID is always a conflict. */
    async create(ctx: Context, agentId: string, input: TaskCreateInput): Promise<Task> {
        this.#assertAgentId(agentId);
        this.#assertInput(taskCreateInputSchema, input, "create");
        const id = input.id ?? this.#newTaskId();
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            const title = normalizeTitle(input.title);
            const detail = normalizeDetail(input.detail);
            const priority = input.priority ?? DEFAULT_TASK_PRIORITY;
            this.#assertTaskId(id);
            const existing = tasks.find((task) => task.id === id);
            if (existing !== undefined) {
                throw new TaskValidationError(`Task "${id}" already exists.`);
            }
            if (tasks.length >= MAX_TASKS_PER_AGENT) {
                throw new TaskValidationError(
                    `This agent already has the maximum of ${MAX_TASKS_PER_AGENT} tasks.`,
                );
            }
            const dependsOn = [...(input.dependsOn ?? [])];
            validateDependencyIds(tasks, id, dependsOn);
            const metadata =
                input.metadata === undefined ? undefined : cloneMetadata(input.metadata);
            const task: Task = {
                id,
                title,
                ...(detail === undefined ? {} : { detail }),
                ...(input.activeForm === undefined
                    ? {}
                    : { activeForm: normalizeActiveForm(input.activeForm) }),
                blocks: [],
                status: "pending",
                priority,
                dependsOn,
                ...(metadata === undefined ? {} : { metadata }),
                ...(input.owner === undefined ? {} : { owner: normalizeOwner(input.owner) }),
                createdAt: at,
                updatedAt: at,
                ordering: nextOrdering(tasks),
            };
            const nextTasks = syncDependencyEdges([...tasks, task]);
            this.#validateTasks(nextTasks);
            return {
                result: nextTasks.find((candidate) => candidate.id === id) as Task,
                tasks: nextTasks,
                event: this.#event(
                    {
                        type: "task_created",
                        agentId,
                        task: nextTasks.find((candidate) => candidate.id === id) as Task,
                    },
                    eventId,
                    at,
                ),
            };
        });
        return change.result;
    }

    /** Update a task while retaining its stable ID and ordering. */
    async update(
        ctx: Context,
        agentId: string,
        taskId: string,
        changes: TaskUpdateInput,
    ): Promise<Task> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        this.#assertInput(taskUpdateInputSchema, changes, "update");
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) {
                throw new TaskValidationError(`Task "${taskId}" does not exist.`);
            }
            const candidate = this.#applyUpdate(tasks, taskId, changes, at);
            if (!candidate.changed) return { result: existing };
            const updatedTask = candidate.tasks.find((task) => task.id === taskId) as Task;
            void txCtx;
            const event =
                updatedTask.status === "completed" && existing.status !== "completed"
                    ? this.#event(
                          { type: "task_completed", agentId, task: updatedTask },
                          eventId,
                          at,
                      )
                    : this.#event(
                          { type: "task_updated", agentId, task: updatedTask, changes },
                          eventId,
                          at,
                      );
            return {
                result: updatedTask,
                tasks: candidate.tasks,
                event,
            };
        });
        return change.result;
    }

    /** Mark one task complete. Completing it twice returns the same task. */
    async complete(ctx: Context, agentId: string, taskId: string): Promise<Task> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) {
                throw new TaskValidationError(`Task "${taskId}" does not exist.`);
            }
            if (existing.status === "completed") return { result: existing };
            const task: Task = {
                ...existing,
                status: "completed",
                updatedAt: at,
            };
            void txCtx;
            return {
                result: task,
                tasks: tasks.map((candidate) => (candidate.id === taskId ? task : candidate)),
                event: this.#event({ type: "task_completed", agentId, task }, eventId, at),
            };
        });
        return change.result;
    }

    /** Remove a task and unlink it from every remaining task's dependency graph. */
    async remove(ctx: Context, agentId: string, taskId: string): Promise<boolean> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) return { result: false };
            const remaining = compactOrdering(
                tasks.filter((task) => task.id !== taskId),
                at,
            );
            const unlinked = remaining.map((task) =>
                task.dependsOn.includes(taskId)
                    ? {
                          ...task,
                          dependsOn: task.dependsOn.filter((dependency) => dependency !== taskId),
                          updatedAt: at,
                      }
                    : task,
            );
            const normalized = syncDependencyEdges(unlinked);
            void txCtx;
            return {
                result: true,
                tasks: normalized,
                event: this.#event({ type: "task_removed", agentId, taskId }, eventId, at),
            };
        });
        return change.result;
    }

    /** Set an exact complete order for all current tasks. */
    async reorder(
        ctx: Context,
        agentId: string,
        taskIds: readonly string[],
    ): Promise<readonly Task[]> {
        this.#assertAgentId(agentId);
        if (!Value.Check(taskReorderIdsSchema, taskIds)) {
            throw new TaskValidationError(
                "Task reorder expects a unique bounded list of task IDs.",
            );
        }
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            if (taskIds.length !== tasks.length) {
                throw new TaskValidationError(
                    "Task reorder must include every current task exactly once.",
                );
            }
            const byId = new Map(tasks.map((task) => [task.id, task]));
            const reordered = taskIds.map((taskId, ordering) => {
                const task = byId.get(taskId);
                if (task === undefined) {
                    throw new TaskValidationError(`Task "${taskId}" does not exist.`);
                }
                return task.ordering === ordering ? task : { ...task, ordering, updatedAt: at };
            });
            const normalized = syncDependencyEdges(reordered);
            this.#validateTasks(normalized);
            if (reordered.every((task, index) => task.id === tasks[index]?.id)) {
                return { result: this.#sort(tasks) };
            }
            void txCtx;
            return {
                result: normalized,
                tasks: normalized,
                event: this.#event(
                    { type: "tasks_reordered", agentId, tasks: [...normalized] },
                    eventId,
                    at,
                ),
            };
        });
        return change.result;
    }

    /** Clear all tasks for one agent and return how many were removed. */
    async reset(ctx: Context, agentId: string): Promise<number> {
        this.#assertAgentId(agentId);
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            if (tasks.length === 0) return { result: 0 };
            void txCtx;
            return {
                result: tasks.length,
                tasks: [],
                event: this.#event(
                    { type: "tasks_reset", agentId, removed: tasks.length },
                    eventId,
                    at,
                ),
            };
        });
        return change.result;
    }

    readonly #hooks: AgentModuleHooks = {
        /** The common provider-neutral task tools exposed to each agent. */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            createTaskTool(this, scope.agent.id),
            listTasksTool(this, scope.agent.id),
            getTaskTool(this, scope.agent.id),
            updateTaskTool(this, scope.agent.id),
            completeTaskTool(this, scope.agent.id),
            removeTaskTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** Render a bounded model-facing task summary without changing the structured result. */
    formatForModel(tasks: readonly Task[]): string {
        const completed = new Set(
            tasks.filter((task) => task.status === "completed").map((task) => task.id),
        );
        const full =
            tasks.length === 0
                ? "No tasks."
                : tasks
                      .map((task) => {
                          const unresolved = task.dependsOn.filter(
                              (dependency) => !completed.has(dependency),
                          );
                          return [
                              compactTaskRow({ ...task, dependsOn: unresolved }),
                              ...(task.activeForm === undefined
                                  ? []
                                  : [`  Active form: ${task.activeForm}`]),
                              ...(task.detail === undefined ? [] : [`  Detail: ${task.detail}`]),
                              ...(task.metadata === undefined
                                  ? []
                                  : [`  Metadata: ${JSON.stringify(task.metadata)}`]),
                          ].join("\n");
                      })
                      .join("\n");
        if (full.length <= MAX_TASK_OUTPUT_CHARACTERS) return full;
        return `${full.slice(0, MAX_TASK_OUTPUT_CHARACTERS - 32)}\n[task list truncated]`;
    }

    /**
     * Render a list page without hiding any returned task identity.
     *
     * `listPage` already reduces the returned page until these compact rows fit
     * `MAX_TASK_OUTPUT_CHARACTERS`. Full detail remains available through `get_task`.
     */
    formatPageForModel(page: TaskPage): string {
        if (!Value.Check(taskPageSchema, page)) {
            throw new Error("Cannot format an invalid task page.");
        }
        const rows = page.tasks.map(compactTaskRow);
        const suffix =
            page.nextOffset === undefined ? "" : `\nMore tasks start at offset ${page.nextOffset}.`;
        const output = `${rows.length === 0 ? "No tasks." : rows.join("\n")}${suffix}`;
        if (output.length > MAX_TASK_OUTPUT_CHARACTERS) {
            throw new Error("Task page exceeds its model-output bound.");
        }
        return output;
    }

    /**
     * Bound one rendered mutation result to the same model-output limit as every other rendering.
     *
     * A mutation answer echoes fields the caller supplied, and a title alone may be longer than
     * the bound, so the sentence a tool hands back is cut to fit and says that it was.
     */
    formatMutationForModel(text: string): string {
        if (text.length <= MAX_TASK_OUTPUT_CHARACTERS) return text;
        const suffix = "\n[truncated]";
        return `${text.slice(0, MAX_TASK_OUTPUT_CHARACTERS - suffix.length)}${suffix}`;
    }

    /** Render one bounded task lookup page and preserve every returned cursor. */
    formatDetailPageForModel(page: TaskDetailPage): string {
        if (!Value.Check(taskDetailPageSchema, page)) {
            throw new Error("Cannot format an invalid task detail page.");
        }
        if (page.task === null) return "That task does not exist.";
        const output = formatTaskDetailPage(page, MAX_TASK_OUTPUT_CHARACTERS);
        if (output.length > MAX_TASK_OUTPUT_CHARACTERS) {
            throw new Error("Task detail page exceeds its model-output bound.");
        }
        return output;
    }

    async #change<Result>(
        ctx: Context,
        agentId: string,
        decide: (
            txCtx: Context,
            tasks: readonly Task[],
            eventId: string,
            at: number,
        ) => Promise<TaskChange<Result> & { readonly tasks?: readonly Task[] }>,
    ): Promise<TaskChange<Result>> {
        const eventId = globalThis.crypto.randomUUID();
        this.#assertEventId(eventId);
        const at = this.#timestamp();
        return await this.#serialize(agentId, async () =>
            ctx.inTx(async (txCtx) => {
                const store = taskKV(agentId);
                // The context transaction is the durable boundary for the complete
                // read-decide-write operation. The module deliberately keeps no authoritative
                // per-agent state in memory.
                const tasks = await this.#readFromKV(txCtx, store);
                const decided = await decide(txCtx, tasks, eventId, at);
                const event = decided.event;
                if (decided.tasks !== undefined) {
                    this.#validateTasks(decided.tasks);
                    await this.#write(txCtx, store, decided.tasks);
                } else if (event?.type === "task_created") {
                    await this.#write(txCtx, store, [...tasks, event.task]);
                } else if (event?.type === "task_updated") {
                    await this.#write(
                        txCtx,
                        store,
                        tasks.map((task) => (task.id === event.task.id ? event.task : task)),
                    );
                } else if (event?.type === "task_completed") {
                    await this.#write(
                        txCtx,
                        store,
                        tasks.map((task) => (task.id === event.task.id ? event.task : task)),
                    );
                }
                if (event !== undefined) {
                    for (const listener of this.#transactionalListeners) {
                        await listener(txCtx, event);
                    }
                    // The post-commit observer is told about a change that has already landed, so
                    // it is handed the caller's context rather than the transaction's: by the time
                    // it runs, the transaction context has ended and cannot read anything back.
                    afterCommit(txCtx, () => this.#notifyPostCommit(ctx, event));
                }
                return decided;
            }),
        );
    }

    /**
     * Run one agent's mutations one at a time.
     *
     * A transaction orders durable writes, but it does not keep two concurrent mutations from both
     * reading the same list before either has written: interleaved read-decide-write turns
     * simultaneous creates into one surviving task and silently drops the rest. Mutations for one
     * agent therefore queue behind each other in this process, while different agents stay
     * independent.
     */
    async #serialize<Result>(agentId: string, work: () => Promise<Result>): Promise<Result> {
        const previous = this.#mutations.get(agentId) ?? Promise.resolve();
        const current = previous.then(work, work);
        // The queue only orders work; a failed mutation must not fail the one waiting behind it.
        const tail = current.then(
            () => undefined,
            () => undefined,
        );
        this.#mutations.set(agentId, tail);
        try {
            return await current;
        } finally {
            if (this.#mutations.get(agentId) === tail) this.#mutations.delete(agentId);
        }
    }

    async #read(ctx: Context, agentId: string): Promise<readonly Task[]> {
        return await this.#readFromKV(ctx, taskKV(agentId));
    }

    async #readFromKV(ctx: Context, kv: ReturnType<typeof taskKV>): Promise<readonly Task[]> {
        const value = await kv.read(ctx);
        if (value === undefined) return [];
        if (!Value.Check(taskListSchema, value)) {
            throw new Error("The stored task list is invalid.");
        }
        this.#validateTasks(value);
        return this.#sort(value);
    }

    async #write(
        ctx: Context,
        kv: ReturnType<typeof taskKV>,
        tasks: readonly Task[],
    ): Promise<void> {
        this.#validateTasks(tasks);
        await kv.write(ctx, this.#sort(tasks));
    }

    #applyUpdate(
        tasks: readonly Task[],
        taskId: string,
        changes: TaskUpdateInput,
        at: number,
    ): { readonly tasks: readonly Task[]; readonly task: Task; readonly changed: boolean } {
        const original = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
        const working = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
        const existing = working.get(taskId);
        if (existing === undefined) {
            throw new TaskValidationError(`Task "${taskId}" does not exist.`);
        }

        let detail = existing.detail;
        if (changes.detail !== undefined) detail = normalizeDetail(changes.detail ?? undefined);
        let activeForm = existing.activeForm;
        if (changes.activeForm !== undefined) {
            activeForm =
                changes.activeForm === null ? undefined : normalizeActiveForm(changes.activeForm);
        }
        let owner = existing.owner;
        if (changes.owner !== undefined) {
            owner = changes.owner === null ? undefined : normalizeOwner(changes.owner);
        }
        let metadata = existing.metadata;
        if (changes.metadata !== undefined) {
            assertTaskMetadataPatch(changes.metadata);
            metadata = applyMetadataPatch(existing.metadata, changes.metadata);
        }
        const candidate: Task = {
            ...existing,
            ...(detail === undefined ? {} : { detail }),
            ...(activeForm === undefined ? {} : { activeForm }),
            ...(owner === undefined ? {} : { owner }),
            ...(metadata === undefined ? {} : { metadata }),
            title: changes.title === undefined ? existing.title : normalizeTitle(changes.title),
            priority: changes.priority ?? existing.priority,
            status: changes.status ?? existing.status,
            dependsOn:
                changes.dependsOn === undefined ? [...existing.dependsOn] : [...changes.dependsOn],
        };
        if (detail === undefined) delete candidate.detail;
        if (activeForm === undefined) delete candidate.activeForm;
        if (owner === undefined) delete candidate.owner;
        if (metadata === undefined) delete candidate.metadata;
        working.set(taskId, candidate);

        for (const dependency of [
            ...(changes.dependsOn ?? []),
            ...(changes.addBlockedBy ?? []),
            ...(changes.removeBlockedBy ?? []),
        ]) {
            this.#assertTaskId(dependency);
            if (dependency === taskId) {
                throw new TaskValidationError(`Task "${taskId}" cannot depend on itself.`);
            }
            if (!working.has(dependency)) {
                throw new TaskValidationError(`Task dependency "${dependency}" does not exist.`);
            }
        }
        for (const blockedTaskId of [
            ...(changes.addBlocks ?? []),
            ...(changes.removeBlocks ?? []),
        ]) {
            this.#assertTaskId(blockedTaskId);
            if (blockedTaskId === taskId) {
                throw new TaskValidationError(`Task "${taskId}" cannot depend on itself.`);
            }
            if (!working.has(blockedTaskId)) {
                throw new TaskValidationError(`Task dependency "${blockedTaskId}" does not exist.`);
            }
        }

        const updated = working.get(taskId) as Task;
        if (changes.addBlockedBy !== undefined) {
            updated.dependsOn = appendUnique(updated.dependsOn, changes.addBlockedBy);
        }
        if (changes.removeBlockedBy !== undefined) {
            updated.dependsOn = updated.dependsOn.filter(
                (dependency) => !changes.removeBlockedBy?.includes(dependency),
            );
        }
        for (const blockedTaskId of changes.addBlocks ?? []) {
            const blockedTask = working.get(blockedTaskId) as Task;
            blockedTask.dependsOn = appendUnique(blockedTask.dependsOn, [taskId]);
        }
        for (const blockedTaskId of changes.removeBlocks ?? []) {
            const blockedTask = working.get(blockedTaskId) as Task;
            blockedTask.dependsOn = blockedTask.dependsOn.filter(
                (dependency) => dependency !== taskId,
            );
        }

        const changedIds = new Set<string>();
        for (const [id, task] of working) {
            const before = original.get(id) as Task;
            if (!sameTask(before, task)) changedIds.add(id);
        }
        if (changedIds.size === 0) {
            return { task: existing, tasks, changed: false };
        }
        for (const id of changedIds) {
            const task = working.get(id) as Task;
            working.set(id, { ...task, updatedAt: at });
        }
        const normalized = syncDependencyEdges([...working.values()]);
        this.#validateTasks(normalized);
        return {
            task: normalized.find((task) => task.id === taskId) as Task,
            tasks: normalized,
            changed: true,
        };
    }

    #newTaskId(): string {
        const id = globalThis.crypto.randomUUID();
        this.#assertTaskId(id);
        return id;
    }

    #event(payload: TaskEventPayload, eventId: string, at: number): TaskEvent {
        if (!Value.Check(taskEventPayloadSchema, payload)) {
            throw new Error("Tasks module created an invalid event payload.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(taskEventSchema, event)) {
            throw new Error("Tasks module created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    async #notifyPostCommit(ctx: Context, event: TaskEvent): Promise<void> {
        for (const listener of this.#listeners) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                // The change is already durable; one subscriber cannot make it look failed, and it
                // cannot starve the subscribers queued behind it either.
                ctx.log.warn(
                    "A task subscriber failed after the change was already committed.",
                    { agentId: event.agentId, eventId: event.eventId, type: event.type },
                    error,
                );
            }
        }
    }

    #validateTasks(tasks: readonly Task[]): void {
        if (tasks.length > MAX_TASKS_PER_AGENT || !Value.Check(taskListSchema, tasks)) {
            throw new TaskValidationError(
                "The task list exceeds its bounds or has an invalid shape.",
            );
        }
        if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
            throw new TaskValidationError("Task IDs must be unique.");
        }
        const orderings = [...tasks]
            .map((task) => task.ordering)
            .sort((left, right) => left - right);
        if (!orderings.every((ordering, index) => ordering === index)) {
            throw new TaskValidationError("Task ordering must be unique and contiguous from zero.");
        }
        if (hasCycle(tasks)) {
            throw new TaskValidationError("Task dependencies cannot contain a cycle.");
        }
        for (const task of tasks) {
            if (task.updatedAt < task.createdAt) {
                throw new TaskValidationError(`Task "${task.id}" has an invalid timestamp order.`);
            }
            if (normalizeTitle(task.title) !== task.title) {
                throw new TaskValidationError(`Task "${task.id}" has an invalid title.`);
            }
            if (task.detail !== undefined && normalizeDetail(task.detail) !== task.detail) {
                throw new TaskValidationError(`Task "${task.id}" has invalid detail.`);
            }
            if (
                task.activeForm !== undefined &&
                normalizeActiveForm(task.activeForm) !== task.activeForm
            ) {
                throw new TaskValidationError(`Task "${task.id}" has invalid active form.`);
            }
            if (task.owner !== undefined && normalizeOwner(task.owner) !== task.owner) {
                throw new TaskValidationError(`Task "${task.id}" has invalid owner.`);
            }
            if (task.metadata !== undefined) assertTaskMetadata(task.metadata);
            validateDependencyIds(tasks, task.id, task.dependsOn);
        }
        const expectedBlocks = deriveBlocks(tasks);
        for (const task of tasks) {
            if (!sameIds(task.blocks, expectedBlocks.get(task.id) ?? [])) {
                throw new TaskValidationError(
                    `Task "${task.id}" has inconsistent reverse dependencies.`,
                );
            }
        }
    }

    #assertInput(
        schema: typeof taskCreateInputSchema | typeof taskUpdateInputSchema,
        value: unknown,
        action: string,
    ): void {
        // Metadata is the one field a caller can make self-referential, and the schema walk itself
        // would recurse into it forever, so its shape is established before anything else looks.
        if (typeof value === "object" && value !== null && "metadata" in value) {
            assertTaskMetadataStructure((value as { readonly metadata: unknown }).metadata);
        }
        if (!Value.Check(schema, value)) {
            throw new TaskValidationError(`Invalid task ${action} input.`);
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(agentIdSchema, agentId)) {
            throw new TaskValidationError("Task agent ID is invalid.");
        }
    }

    #assertTaskId(taskId: string): void {
        if (!Value.Check(taskIdSchema, taskId)) {
            throw new TaskValidationError("Task ID is invalid.");
        }
    }

    #assertEventId(eventId: string): void {
        if (!Value.Check(taskEventIdSchema, eventId)) {
            throw new Error("Task event ID is invalid.");
        }
    }

    #timestamp(): number {
        const value = Date.now();
        if (!Value.Check(taskTimestampSchema, value)) {
            throw new Error("The system clock is outside the range a task timestamp can hold.");
        }
        return value;
    }

    #sort(tasks: readonly Task[]): readonly Task[] {
        return [...tasks]
            .sort(
                (left, right) => left.ordering - right.ordering || left.id.localeCompare(right.id),
            )
            .map((task) => structuredClone(task));
    }

    #fitModelPage(requested: readonly Task[], offset: number, total: number): Task[] {
        if (requested.length === 0) return [];
        const visible: Task[] = [];
        for (const task of requested) {
            const candidate = [...visible, task];
            const nextOffset = offset + candidate.length;
            const suffix = nextOffset < total ? `\nMore tasks start at offset ${nextOffset}.` : "";
            const output = `${candidate.map(compactTaskRow).join("\n")}${suffix}`;
            if (output.length > MAX_TASK_OUTPUT_CHARACTERS) break;
            visible.push(task);
        }
        if (visible.length === 0) {
            throw new Error("The task output bound is too small to show one task identity.");
        }
        return visible;
    }

    #fitTaskDetailPage(page: TaskDetailPage): TaskDetailPage {
        if (page.task === null) return page;
        let detail = page.detail;
        let dependencies = [...page.dependencies];
        for (;;) {
            // Keep one visible character/identity whenever the corresponding source has more
            // data. A zero-length retained slice would make its cursor repeat forever.
            const candidate: TaskDetailPage = {
                task: page.task,
                detail,
                detailOffset: page.detailOffset,
                detailTotal: page.detailTotal,
                dependencies,
                dependencyOffset: page.dependencyOffset,
                dependencyTotal: page.dependencyTotal,
                ...(page.detailOffset + detail.length < page.detailTotal
                    ? { nextDetailOffset: page.detailOffset + detail.length }
                    : {}),
                ...(page.dependencyOffset + dependencies.length < page.dependencyTotal
                    ? { nextDependencyOffset: page.dependencyOffset + dependencies.length }
                    : {}),
            };
            if (
                formatTaskDetailPage(candidate, MAX_TASK_OUTPUT_CHARACTERS).length <=
                MAX_TASK_OUTPUT_CHARACTERS
            ) {
                return candidate;
            }
            if (detail.length > 1) {
                const excess = Math.max(
                    1,
                    formatTaskDetailPage(candidate, MAX_TASK_OUTPUT_CHARACTERS).length -
                        MAX_TASK_OUTPUT_CHARACTERS,
                );
                detail = detail.slice(0, Math.max(1, detail.length - excess));
                continue;
            }
            if (dependencies.length > 1) {
                dependencies = dependencies.slice(0, -1);
                continue;
            }
            throw new Error("The task output bound is too small to show one task identity.");
        }
    }
}

function normalizeTitle(title: string): string {
    const normalized = title.trim();
    if (!Value.Check(taskTitleSchema, normalized)) {
        throw new TaskValidationError(
            "Task title must not be empty and must be at most 500 characters.",
        );
    }
    return normalized;
}

function normalizeDetail(detail: string | undefined): string | undefined {
    if (detail === undefined) return undefined;
    const normalized = detail.trim();
    if (!Value.Check(taskDetailSchema, normalized)) {
        throw new TaskValidationError("Task detail must be at most 4000 characters.");
    }
    return normalized.length === 0 ? undefined : normalized;
}

function normalizeActiveForm(activeForm: string): string {
    const normalized = activeForm.trim();
    if (!Value.Check(taskActiveFormSchema, normalized)) {
        throw new TaskValidationError(
            "Task active form must not be empty and must be at most 500 characters.",
        );
    }
    return normalized;
}

function normalizeOwner(owner: string): string {
    const normalized = owner.trim();
    if (!Value.Check(taskOwnerSchema, normalized)) {
        throw new TaskValidationError(
            "Task owner must not be empty and must be at most 256 characters.",
        );
    }
    return normalized;
}

function cloneMetadata(metadata: TaskMetadata): TaskMetadata {
    assertTaskMetadata(metadata);
    return structuredClone(metadata);
}

function applyMetadataPatch(
    existing: TaskMetadata | undefined,
    patch: TaskMetadataPatch,
): TaskMetadata {
    const next: Record<string, unknown> = existing === undefined ? {} : structuredClone(existing);
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = structuredClone(value);
    }
    assertTaskMetadata(next);
    return next as TaskMetadata;
}

function validateDependencyIds(
    tasks: readonly Task[],
    taskId: string,
    dependsOn: readonly string[],
): void {
    for (const dependency of dependsOn) {
        if (dependency === taskId) {
            throw new TaskValidationError(`Task "${taskId}" cannot depend on itself.`);
        }
        if (!tasks.some((task) => task.id === dependency)) {
            throw new TaskValidationError(`Task dependency "${dependency}" does not exist.`);
        }
    }
}

function appendUnique(values: readonly string[], additions: readonly string[]): string[] {
    const next = [...values];
    for (const value of additions) {
        if (!next.includes(value)) next.push(value);
    }
    return next;
}

function syncDependencyEdges(tasks: readonly Task[]): readonly Task[] {
    const blocks = deriveBlocks(tasks);
    return tasks.map((task) => ({
        ...structuredClone(task),
        blocks: [...(blocks.get(task.id) ?? [])],
    }));
}

function deriveBlocks(tasks: readonly Task[]): Map<string, string[]> {
    const blocks = new Map(tasks.map((task) => [task.id, [] as string[]]));
    for (const task of [...tasks].sort((left, right) => left.ordering - right.ordering)) {
        for (const dependency of task.dependsOn) {
            const dependents = blocks.get(dependency);
            if (dependents !== undefined && !dependents.includes(task.id)) {
                dependents.push(task.id);
            }
        }
    }
    return blocks;
}

function sameTask(left: Task, right: Task): boolean {
    return (
        left.id === right.id &&
        left.title === right.title &&
        left.detail === right.detail &&
        left.activeForm === right.activeForm &&
        left.owner === right.owner &&
        left.status === right.status &&
        left.priority === right.priority &&
        sameIds(left.dependsOn, right.dependsOn) &&
        sameIds(left.blocks, right.blocks) &&
        left.createdAt === right.createdAt &&
        left.updatedAt === right.updatedAt &&
        left.ordering === right.ordering &&
        JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
    );
}

function taskForTaskList(task: Task, tasks: readonly Task[]): Task {
    const completed = new Set(
        tasks
            .filter((candidate) => candidate.status === "completed")
            .map((candidate) => candidate.id),
    );
    return {
        ...structuredClone(task),
        dependsOn: task.dependsOn.filter((dependency) => !completed.has(dependency)),
    };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nextOrdering(tasks: readonly Task[]): number {
    return tasks.reduce((largest, task) => Math.max(largest, task.ordering), -1) + 1;
}

function compactOrdering(tasks: readonly Task[], at: number): readonly Task[] {
    return [...tasks]
        .sort((left, right) => left.ordering - right.ordering || left.id.localeCompare(right.id))
        .map((task, ordering) =>
            task.ordering === ordering ? task : { ...task, ordering, updatedAt: at },
        );
}

function compactTaskRow(task: Task): string {
    const fixedPrefix = `${task.id} [${task.status}, ${task.priority}] `;
    const ownerPrefix =
        task.owner === undefined ? fixedPrefix : `${fixedPrefix.slice(0, -1)} (${task.owner}) `;
    const prefix = ownerPrefix.length <= 150 ? ownerPrefix : fixedPrefix;
    const maxTitleCharacters = Math.max(1, 200 - prefix.length);
    const title =
        task.title.length <= maxTitleCharacters
            ? task.title
            : `${task.title.slice(0, Math.max(1, maxTitleCharacters - 1))}…`;
    const dependencyText =
        task.dependsOn.length === 0 ? "" : ` [blocked by ${task.dependsOn.join(", ")}]`;
    const row = `${prefix}${title}`;
    return row.length + dependencyText.length <= 200 ? `${row}${dependencyText}` : row;
}

function formatTaskDetailPage(
    page: Extract<TaskDetailPage, { task: Task }>,
    maxOutputCharacters?: number,
): string {
    const lines = [compactTaskRow(page.task)];
    if (page.task.activeForm !== undefined) {
        lines.push(`Active form: ${page.task.activeForm}`);
    }
    if (page.task.owner !== undefined) {
        lines.push(`Owner: ${page.task.owner}`);
    }
    if (page.detail.length > 0) {
        lines.push(`Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`);
    }
    if (page.dependencies.length > 0) {
        lines.push(
            `Depends on [${page.dependencyOffset}/${page.dependencyTotal}]: ${page.dependencies.join(", ")}`,
        );
    }
    if (page.task.blocks.length > 0) {
        lines.push(`Blocks: ${page.task.blocks.join(", ")}`);
    }
    if (page.task.metadata !== undefined) {
        lines.push(`Metadata: ${JSON.stringify(page.task.metadata)}`);
    }
    if (page.nextDetailOffset !== undefined) {
        lines.push(`More detail starts at offset ${page.nextDetailOffset}.`);
    }
    if (page.nextDependencyOffset !== undefined) {
        lines.push(`More dependencies start at offset ${page.nextDependencyOffset}.`);
    }
    const full = lines.join("\n");
    if (maxOutputCharacters === undefined || full.length <= maxOutputCharacters) return full;

    // A maximum-length task ID and dependency ID cannot both fit in the ordinary header at the
    // schema's 256-character minimum. The compact form may omit the redundant task header while
    // the caller is already looking up that task, preserving every dependency identity and cursor.
    const compactWithHeader = formatCompactTaskDetailPage(page, true);
    if (compactWithHeader.length <= maxOutputCharacters) return compactWithHeader;
    return formatCompactTaskDetailPage(page, false);
}

function formatCompactTaskDetailPage(
    page: Extract<TaskDetailPage, { task: Task }>,
    includeHeader: boolean,
): string {
    const lines: string[] = includeHeader ? [page.task.id] : [];
    if (page.detail.length > 0) {
        lines.push(`Detail: ${page.detail}`);
    }
    if (page.dependencies.length > 0) {
        lines.push(`Depends on: ${page.dependencies.join(", ")}`);
    }
    if (page.nextDetailOffset !== undefined) {
        lines.push(`More detail: ${page.nextDetailOffset}.`);
    }
    if (page.nextDependencyOffset !== undefined) {
        lines.push(`More dependencies: ${page.nextDependencyOffset}.`);
    }
    return lines.join("\n");
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function hasCycle(tasks: readonly Task[]): boolean {
    const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const dependency of dependencies.get(id) ?? []) {
            if (visit(dependency)) return true;
        }
        visiting.delete(id);
        visited.add(id);
        return false;
    };
    return tasks.some((task) => visit(task.id));
}

function assertTaskEventListener(value: unknown): asserts value is TaskEventListener {
    if (!Value.Check(taskEventListenerSchema, value)) {
        throw new Error("A task subscriber must be a function taking a context and an event.");
    }
}
