import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    taskEventIdSchema,
    taskEventPayloadSchema,
    taskEventSchema,
    taskFeatureListenerSchema,
    type TaskEvent,
    type TaskEventPayload,
    type TaskFeatureListener,
} from "./TaskEvent.js";
import {
    taskCreateInputSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskSchema,
    taskStatusSchema,
    taskTitleSchema,
    taskTimestampSchema,
    taskUpdateInputSchema,
    type Task,
    type TaskCreateInput,
    type TaskId,
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
import { taskStorageSchema, type TaskStorage } from "./TaskStore.js";
import { completeTaskTool } from "./tools/complete_task.js";
import { createTaskTool } from "./tools/create_task.js";
import { getTaskTool } from "./tools/get_task.js";
import { listTasksTool } from "./tools/list_tasks.js";
import { updateTaskTool } from "./tools/update_task.js";

/** The largest list a feature will accept, regardless of host configuration. */
export const MAX_TASKS = 500;
/** The default cap for one agent's task list. */
export const DEFAULT_MAX_TASKS = 100;
/** The default priority for newly created tasks. */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";
/** The key holding the task list in the feature's per-agent KV. */
const TASKS_KEY = "items";
const taskListSchema = Type.Array(taskSchema, { maxItems: MAX_TASKS });
const taskReorderIdsSchema = Type.Array(taskIdSchema, {
    maxItems: MAX_TASKS,
    uniqueItems: true,
});
const agentIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const maxTasksSchema = Type.Integer({ minimum: 1, maximum: MAX_TASKS });
const outputCharactersSchema = Type.Integer({ minimum: 256, maximum: 100_000 });
const maxPageSizeSchema = Type.Integer({ minimum: 1, maximum: 100 });
const DEFAULT_PAGE_SIZE = 50;
const CREATE_ID_KEY = "create_task_id";
const opaqueContextSchema = Type.Any();
const opaqueResultSchema = Type.Any();
const tasksFeatureOptionsSchema = Type.Object(
    {
        storage: taskStorageSchema,
        maxTasks: Type.Optional(maxTasksSchema),
        defaultPriority: Type.Optional(taskPrioritySchema),
        listener: Type.Optional(taskFeatureListenerSchema),
        idFactory: Type.Optional(
            Type.Function([opaqueContextSchema, agentIdSchema], opaqueResultSchema),
        ),
        clock: Type.Optional(Type.Function([], taskTimestampSchema)),
        maxOutputCharacters: Type.Optional(outputCharactersSchema),
        maxPageSize: Type.Optional(maxPageSizeSchema),
        afterCommit: Type.Function(
            [opaqueContextSchema, Type.Function([opaqueContextSchema], opaqueResultSchema)],
            Type.Void(),
        ),
        onPostCommitError: Type.Optional(
            Type.Function(
                [opaqueContextSchema, taskEventSchema, opaqueResultSchema],
                opaqueResultSchema,
            ),
        ),
        eventIdFactory: Type.Optional(
            Type.Function([opaqueContextSchema, agentIdSchema], opaqueResultSchema),
        ),
    },
    { additionalProperties: false },
);

/** How a task feature is configured by the host. */
export { tasksFeatureOptionsSchema };
export type TasksFeatureOptions = Static<typeof tasksFeatureOptionsSchema>;

interface TaskChange<Result> {
    readonly result: Result;
    readonly event?: TaskEvent;
}

interface TaskUpdateCandidate {
    readonly task: Task;
    readonly changed: boolean;
}

/**
 * A bounded persistent task list.
 *
 * One instance serves all agents in a collection. Every agent's list is kept under that agent's
 * feature KV, and each mutation uses that store's transaction as the read-decide-write boundary.
 * The feature owns no database, filesystem, or agent lifecycle; a host only supplies AgentStorage
 * and may project TaskEvents into its own API.
 */
export class TasksFeature implements AgentFeature {
    readonly name = "tasks";

    readonly #storage: TaskStorage;
    readonly #maxTasks: number;
    readonly #defaultPriority: TaskPriority;
    readonly #listener: TaskFeatureListener | undefined;
    readonly #idFactory: (ctx: Context, agentId: string) => string | Promise<string>;
    readonly #clock: () => number;
    readonly #maxOutputCharacters: number;
    readonly #maxPageSize: number;
    readonly #afterCommit: (
        ctx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ) => void;
    readonly #onPostCommitError:
        | ((ctx: Context, event: TaskEvent, error: unknown) => void | Promise<void>)
        | undefined;
    readonly #eventIdFactory: (ctx: Context, agentId: string) => string | Promise<string>;

    constructor(options: TasksFeatureOptions) {
        assertTasksFeatureOptions(options);
        this.#storage = options.storage;
        this.#maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
        if (!Value.Check(maxTasksSchema, this.#maxTasks)) {
            throw new Error(`Tasks maxTasks must be an integer from 1 to ${MAX_TASKS}.`);
        }
        this.#defaultPriority = options.defaultPriority ?? DEFAULT_TASK_PRIORITY;
        if (!Value.Check(taskPrioritySchema, this.#defaultPriority)) {
            throw new Error("Tasks default priority is invalid.");
        }
        this.#listener = options.listener;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#maxOutputCharacters = options.maxOutputCharacters ?? 12_000;
        if (!Value.Check(outputCharactersSchema, this.#maxOutputCharacters)) {
            throw new Error("Tasks maxOutputCharacters must be between 256 and 100000.");
        }
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        if (!Value.Check(maxPageSizeSchema, this.#maxPageSize)) {
            throw new Error("Tasks maxPageSize must be between 1 and 100.");
        }
        this.#afterCommit = options.afterCommit;
        this.#onPostCommitError = options.onPostCommitError;
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
    }

    /** Return this agent's tasks in deterministic display order. */
    async list(ctx: Context, agentId: string): Promise<readonly Task[]> {
        this.#assertAgentId(agentId);
        return this.#sort(await this.#read(ctx, agentId));
    }

    /** Return one bounded page; callers can follow nextOffset until every task is visible. */
    async listPage(ctx: Context, agentId: string, query: TaskPageQuery = {}): Promise<TaskPage> {
        this.#assertAgentId(agentId);
        if (!Value.Check(taskPageQuerySchema, query)) {
            throw new Error("Invalid task page query.");
        }
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Task page limit cannot exceed ${this.#maxPageSize}.`);
        }
        const offset = query.offset ?? 0;
        const tasks = await this.#read(ctx, agentId);
        const requestedTasks = tasks.slice(offset, offset + limit);
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
            throw new Error("Tasks feature created an invalid task page.");
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

    /** Create one task, or return an identical existing task for an idempotent repeated ID. */
    async create(ctx: Context, agentId: string, input: TaskCreateInput): Promise<Task> {
        this.#assertAgentId(agentId);
        this.#assertInput(taskCreateInputSchema, input, "create");
        const id = await this.#createId(ctx, agentId, input.id);
        const change = await this.#change(ctx, agentId, async (txCtx, tasks, eventId, at) => {
            const title = normalizeTitle(input.title);
            const detail = normalizeDetail(input.detail);
            const priority = input.priority ?? this.#defaultPriority;
            this.#assertTaskId(id);
            const existing = tasks.find((task) => task.id === id);
            if (existing !== undefined) {
                const same =
                    existing.title === title &&
                    existing.detail === detail &&
                    existing.priority === priority &&
                    sameIds(existing.dependsOn, input.dependsOn ?? []);
                if (same) return { result: existing };
                throw new Error(`Task "${id}" already exists with different values.`);
            }
            if (tasks.length >= this.#maxTasks) {
                throw new Error(`This agent already has the maximum of ${this.#maxTasks} tasks.`);
            }
            const dependsOn = [...(input.dependsOn ?? [])];
            this.#validateDependencies(tasks, id, dependsOn);
            const task: Task = {
                id,
                title,
                ...(detail === undefined ? {} : { detail }),
                status: "pending",
                priority,
                dependsOn,
                createdAt: at,
                updatedAt: at,
                ordering: nextOrdering(tasks),
            };
            this.#validateTasks([...tasks, task]);
            return {
                result: task,
                event: this.#event({ type: "task_created", agentId, task }, eventId, at),
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
        const change = await this.#change(ctx, agentId, (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) throw new Error(`Task "${taskId}" does not exist.`);
            const candidate = this.#candidate(existing, changes, at);
            if (!candidate.changed) return { result: existing };
            this.#validateDependencies(tasks, taskId, candidate.task.dependsOn);
            this.#validateTasks(tasks.map((task) => (task.id === taskId ? candidate.task : task)));
            void txCtx;
            const event =
                candidate.task.status === "completed" && existing.status !== "completed"
                    ? this.#event(
                          { type: "task_completed", agentId, task: candidate.task },
                          eventId,
                          at,
                      )
                    : this.#event(
                          { type: "task_updated", agentId, task: candidate.task, changes },
                          eventId,
                          at,
                      );
            return {
                result: candidate.task,
                event,
            };
        });
        return change.result;
    }

    /** Mark one task complete. Completing it twice returns the same durable task. */
    async complete(ctx: Context, agentId: string, taskId: string): Promise<Task> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        const change = await this.#change(ctx, agentId, (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) throw new Error(`Task "${taskId}" does not exist.`);
            if (existing.status === "completed") return { result: existing };
            const task: Task = {
                ...existing,
                status: "completed",
                updatedAt: at,
            };
            void txCtx;
            return {
                result: task,
                event: this.#event({ type: "task_completed", agentId, task }, eventId, at),
            };
        });
        return change.result;
    }

    /** Remove a task. Removal is refused while another task depends on it. */
    async remove(ctx: Context, agentId: string, taskId: string): Promise<boolean> {
        this.#assertAgentId(agentId);
        this.#assertTaskId(taskId);
        const change = await this.#change(ctx, agentId, (txCtx, tasks, eventId, at) => {
            const existing = tasks.find((task) => task.id === taskId);
            if (existing === undefined) return { result: false };
            const dependent = tasks.find((task) => task.dependsOn.includes(taskId));
            if (dependent !== undefined) {
                throw new Error(
                    `Task "${taskId}" cannot be removed while "${dependent.id}" depends on it.`,
                );
            }
            const remaining = compactOrdering(
                tasks.filter((task) => task.id !== taskId),
                at,
            );
            void txCtx;
            return {
                result: true,
                tasks: remaining,
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
            throw new Error("Task reorder expects a unique bounded list of task IDs.");
        }
        const change = await this.#change(ctx, agentId, (txCtx, tasks, eventId, at) => {
            if (taskIds.length !== tasks.length) {
                throw new Error("Task reorder must include every current task exactly once.");
            }
            const byId = new Map(tasks.map((task) => [task.id, task]));
            const reordered = taskIds.map((taskId, ordering) => {
                const task = byId.get(taskId);
                if (task === undefined) throw new Error(`Task "${taskId}" does not exist.`);
                return task.ordering === ordering ? task : { ...task, ordering, updatedAt: at };
            });
            this.#validateTasks(reordered);
            if (reordered.every((task, index) => task.id === tasks[index]?.id)) {
                return { result: this.#sort(tasks) };
            }
            void txCtx;
            return {
                result: reordered,
                tasks: reordered,
                event: this.#event(
                    { type: "tasks_reordered", agentId, tasks: reordered },
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
        const change = await this.#change(ctx, agentId, (txCtx, tasks, eventId, at) => {
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

    /** The common provider-neutral task tools exposed to each agent. */
    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        createTaskTool(this, scope.agent.id),
        listTasksTool(this, scope.agent.id),
        getTaskTool(this, scope.agent.id),
        updateTaskTool(this, scope.agent.id),
        completeTaskTool(this, scope.agent.id),
    ];

    /** Render a bounded model-facing task summary without changing the structured result. */
    formatForModel(tasks: readonly Task[]): string {
        const full =
            tasks.length === 0
                ? "No tasks."
                : tasks
                      .map((task) =>
                          [
                              `${task.id} [${task.status}, ${task.priority}] ${task.title}`,
                              ...(task.detail === undefined ? [] : [`  Detail: ${task.detail}`]),
                              ...(task.dependsOn.length === 0
                                  ? []
                                  : [`  Depends on: ${task.dependsOn.join(", ")}`]),
                          ].join("\n"),
                      )
                      .join("\n");
        if (full.length <= this.#maxOutputCharacters) return full;
        return `${full.slice(0, this.#maxOutputCharacters - 32)}\n[task list truncated]`;
    }

    /**
     * Render a list page without hiding any returned task identity.
     *
     * `listPage` already reduces the returned page until these compact rows fit the configured
     * output bound. Full detail remains available through `get_task`.
     */
    formatPageForModel(page: TaskPage): string {
        if (!Value.Check(taskPageSchema, page)) {
            throw new Error("Cannot format an invalid task page.");
        }
        const rows = page.tasks.map(compactTaskRow);
        const suffix =
            page.nextOffset === undefined ? "" : `\nMore tasks start at offset ${page.nextOffset}.`;
        const output = `${rows.length === 0 ? "No tasks." : rows.join("\n")}${suffix}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Task page exceeds its model-output bound.");
        }
        return output;
    }

    /** Render one bounded task lookup page and preserve every returned cursor. */
    formatDetailPageForModel(page: TaskDetailPage): string {
        if (!Value.Check(taskDetailPageSchema, page)) {
            throw new Error("Cannot format an invalid task detail page.");
        }
        if (page.task === null) return "That task does not exist.";
        const output = formatTaskDetailPage(page, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
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
        ) =>
            | Promise<TaskChange<Result> & { readonly tasks?: readonly Task[] }>
            | (TaskChange<Result> & { readonly tasks?: readonly Task[] }),
    ): Promise<TaskChange<Result>> {
        const store = taskKV(this.#storage, agentId);
        const eventId = await this.#eventIdFactory(ctx, agentId);
        this.#assertEventId(eventId);
        const at = this.#timestamp();
        const changed = await store.transaction(ctx, async (kv, txCtx) => {
            // AgentKV's transaction is the serialization boundary for the complete
            // read-decide-write operation. The feature deliberately keeps no authoritative
            // per-agent state in memory.
            const tasks = await this.#readFromKV(txCtx, kv);
            const decided = await decide(txCtx, tasks, eventId, at);
            const event = decided.event;
            if (decided.tasks !== undefined) {
                this.#validateTasks(decided.tasks);
                await this.#write(txCtx, kv, decided.tasks);
            } else if (event?.type === "task_created") {
                await this.#write(txCtx, kv, [...tasks, event.task]);
            } else if (event?.type === "task_updated") {
                await this.#write(
                    txCtx,
                    kv,
                    tasks.map((task) => (task.id === event.task.id ? event.task : task)),
                );
            } else if (event?.type === "task_completed") {
                await this.#write(
                    txCtx,
                    kv,
                    tasks.map((task) => (task.id === event.task.id ? event.task : task)),
                );
            }
            if (event !== undefined) {
                await this.#listener?.onEventTransactional?.(txCtx, event);
                const registrationResult: unknown = this.#afterCommit(txCtx, (postCommitCtx) =>
                    this.#notifyPostCommit(postCommitCtx, event),
                );
                if (registrationResult !== undefined) {
                    throw new Error(
                        "Tasks afterCommit must register synchronously and return undefined.",
                    );
                }
            }
            return decided;
        });
        return changed;
    }

    async #read(ctx: Context, agentId: string): Promise<readonly Task[]> {
        return await this.#readFromKV(ctx, taskKV(this.#storage, agentId));
    }

    async #readFromKV(ctx: Context, kv: ReturnType<typeof taskKV>): Promise<readonly Task[]> {
        const value = await kv.read(ctx, TASKS_KEY);
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
        await kv.write(ctx, TASKS_KEY, this.#sort(tasks));
    }

    #candidate(existing: Task, changes: TaskUpdateInput, at: number): TaskUpdateCandidate {
        const title = changes.title === undefined ? existing.title : normalizeTitle(changes.title);
        const detail =
            changes.detail === undefined
                ? existing.detail
                : normalizeDetail(changes.detail ?? undefined);
        const priority = changes.priority ?? existing.priority;
        const status = changes.status ?? existing.status;
        const dependsOn =
            changes.dependsOn === undefined ? existing.dependsOn : [...changes.dependsOn];
        const changed =
            existing.title !== title ||
            existing.detail !== detail ||
            existing.priority !== priority ||
            existing.status !== status ||
            !sameIds(existing.dependsOn, dependsOn);
        if (!changed) return { task: existing, changed: false };
        const { detail: _existingDetail, ...withoutDetail } = existing;
        const task: Task = {
            ...withoutDetail,
            ...(detail === undefined ? {} : { detail }),
            title,
            priority,
            status,
            dependsOn,
            updatedAt: at,
        };
        return {
            changed: true,
            task,
        };
    }

    async #createId(ctx: Context, agentId: string, requested: string | undefined): Promise<string> {
        if (requested !== undefined) return requested;
        const callStore = agentKV(ctx);
        if (callStore === undefined) return await this.#newTaskId(ctx, agentId);
        return await callStore.transaction(ctx, async (kv, txCtx) => {
            const stored = await kv.read(txCtx, CREATE_ID_KEY);
            if (stored !== undefined) {
                if (!Value.Check(taskIdSchema, stored)) {
                    throw new Error("The durable task creation ID is invalid.");
                }
                return stored as TaskId;
            }
            const id = await this.#newTaskId(txCtx, agentId);
            await kv.write(txCtx, CREATE_ID_KEY, id);
            return id;
        });
    }

    async #newTaskId(ctx: Context, agentId: string): Promise<string> {
        const id = await this.#idFactory(ctx, agentId);
        this.#assertTaskId(id);
        return id;
    }

    #event(payload: TaskEventPayload, eventId: string, at: number): TaskEvent {
        if (!Value.Check(taskEventPayloadSchema, payload)) {
            throw new Error("Tasks feature created an invalid event payload.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(taskEventSchema, event)) {
            throw new Error("Tasks feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    async #notifyPostCommit(ctx: Context, event: TaskEvent): Promise<void> {
        try {
            await this.#listener?.onEvent?.(ctx, event);
        } catch (error: unknown) {
            try {
                await this.#onPostCommitError?.(ctx, event, error);
            } catch {
                // Reporting is advisory and must not turn a committed mutation into a failure.
            }
        }
    }

    #validateDependencies(tasks: readonly Task[], taskId: string, dependsOn: readonly string[]) {
        for (const dependency of dependsOn) {
            this.#assertTaskId(dependency);
            if (dependency === taskId) {
                throw new Error(`Task "${taskId}" cannot depend on itself.`);
            }
            if (!tasks.some((task) => task.id === dependency)) {
                throw new Error(`Task dependency "${dependency}" does not exist.`);
            }
        }
        const candidate = tasks.map((task) =>
            task.id === taskId ? { ...task, dependsOn: [...dependsOn] } : task,
        );
        if (hasCycle(candidate)) {
            throw new Error("Task dependencies cannot contain a cycle.");
        }
    }

    #validateTasks(tasks: readonly Task[]): void {
        if (tasks.length > this.#maxTasks || !Value.Check(taskListSchema, tasks)) {
            throw new Error("The task list exceeds its configured bounds or has an invalid shape.");
        }
        if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
            throw new Error("Task IDs must be unique.");
        }
        const orderings = [...tasks]
            .map((task) => task.ordering)
            .sort((left, right) => left - right);
        if (!orderings.every((ordering, index) => ordering === index)) {
            throw new Error("Task ordering must be unique and contiguous from zero.");
        }
        if (hasCycle(tasks)) throw new Error("Task dependencies cannot contain a cycle.");
        for (const task of tasks) {
            if (task.updatedAt < task.createdAt) {
                throw new Error(`Task "${task.id}" has an invalid timestamp order.`);
            }
            if (normalizeTitle(task.title) !== task.title) {
                throw new Error(`Task "${task.id}" has an invalid title.`);
            }
            if (task.detail !== undefined && normalizeDetail(task.detail) !== task.detail) {
                throw new Error(`Task "${task.id}" has invalid detail.`);
            }
            this.#validateDependenciesExist(tasks, task);
        }
    }

    #validateDependenciesExist(tasks: readonly Task[], task: Task): void {
        for (const dependency of task.dependsOn) {
            if (dependency === task.id || !tasks.some((candidate) => candidate.id === dependency)) {
                throw new Error(`Task "${task.id}" has an invalid dependency.`);
            }
        }
    }

    #assertInput(
        schema: typeof taskCreateInputSchema | typeof taskUpdateInputSchema,
        value: unknown,
        action: string,
    ): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid task ${action} input.`);
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(agentIdSchema, agentId)) throw new Error("Task agent ID is invalid.");
    }

    #assertTaskId(taskId: string): void {
        if (!Value.Check(taskIdSchema, taskId)) throw new Error("Task ID is invalid.");
    }

    #assertEventId(eventId: string): void {
        if (!Value.Check(taskEventIdSchema, eventId)) {
            throw new Error("Task event ID is invalid.");
        }
    }

    #timestamp(): number {
        const value = this.#clock();
        if (!Value.Check(taskTimestampSchema, value)) {
            throw new Error("Tasks clock must return a non-negative integer timestamp.");
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
            if (output.length > this.#maxOutputCharacters) break;
            visible.push(task);
        }
        if (visible.length === 0) {
            throw new Error("Tasks maxOutputCharacters is too small to expose one task identity.");
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
                formatTaskDetailPage(candidate, this.#maxOutputCharacters).length <=
                this.#maxOutputCharacters
            ) {
                return candidate;
            }
            if (detail.length > 1) {
                const excess = Math.max(
                    1,
                    formatTaskDetailPage(candidate, this.#maxOutputCharacters).length -
                        this.#maxOutputCharacters,
                );
                detail = detail.slice(0, Math.max(1, detail.length - excess));
                continue;
            }
            if (dependencies.length > 1) {
                dependencies = dependencies.slice(0, -1);
                continue;
            }
            throw new Error("Tasks maxOutputCharacters is too small to expose task identity.");
        }
    }
}

function normalizeTitle(title: string): string {
    const normalized = title.trim();
    if (!Value.Check(taskTitleSchema, normalized)) {
        throw new Error("Task title must not be empty and must be at most 500 characters.");
    }
    return normalized;
}

function normalizeDetail(detail: string | undefined): string | undefined {
    if (detail === undefined) return undefined;
    const normalized = detail.trim();
    if (!Value.Check(taskDetailSchema, normalized)) {
        throw new Error("Task detail must be at most 4000 characters.");
    }
    return normalized.length === 0 ? undefined : normalized;
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
    const prefix = `${task.id} [${task.status}, ${task.priority}] `;
    const maxTitleCharacters = Math.max(1, 200 - prefix.length);
    const title =
        task.title.length <= maxTitleCharacters
            ? task.title
            : `${task.title.slice(0, Math.max(1, maxTitleCharacters - 1))}…`;
    return `${prefix}${title}`;
}

function formatTaskDetailPage(
    page: Extract<TaskDetailPage, { task: Task }>,
    maxOutputCharacters?: number,
): string {
    const lines = [compactTaskRow(page.task)];
    if (page.detail.length > 0) {
        lines.push(`Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`);
    }
    if (page.dependencies.length > 0) {
        lines.push(
            `Depends on [${page.dependencyOffset}/${page.dependencyTotal}]: ${page.dependencies.join(", ")}`,
        );
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

/** Validate an injected feature configuration at the runtime boundary. */
export function assertTasksFeatureOptions(value: unknown): asserts value is TasksFeatureOptions {
    if (!Value.Check(tasksFeatureOptionsSchema, value)) {
        throw new Error(
            "Tasks feature options are invalid; check the closed storage, listener, and callback contracts.",
        );
    }
}
