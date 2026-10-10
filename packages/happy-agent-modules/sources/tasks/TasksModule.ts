import { createId } from "@paralleldrive/cuid2";
import {
    cuid2Schema,
    currentAgentEnvironment,
    type AgentConfig,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { computePermissions, RunnerUnavailableError } from "@slopus/happy-agent-compute";
import { afterCommit, backoff, type Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProjectsModule } from "../projects/index.js";
import type { RunnersModule } from "../runners/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { isUserOriginMetadata, senderAgentIdMetadata } from "../impl/messageOrigin.js";

import {
    archiveTaskCleanupSchema,
    createTaskInputSchema,
    STANDALONE_TASK_MEMBER,
    taskMemberIdSchema,
    taskRecordSchema,
    TASK_ARCHIVE_FUNCTION,
    TaskConflictError,
    TaskInputError,
    TaskNotFoundError,
    type CreateTaskInput,
    type TaskCreation,
    type TaskMemberId,
    type TaskMembership,
    type TaskRecord,
} from "./Task.js";
import {
    taskEventSchema,
    type TaskEvent,
    type TaskEventListener,
    type TaskUnsubscribe,
} from "./TaskEvent.js";
import { taskMigrations } from "./TaskMigrations.js";
import {
    deleteMembership,
    insertMembership,
    insertTask,
    readMembership,
    readMemberships,
    readTask,
    readTaskByAgent,
    readTaskByFolderName,
    readTaskByWorkspace,
    readTasks,
    updateMembershipOrder,
    updateTask,
} from "./TaskStore.js";
import { deriveTaskFolderName } from "./impl/deriveTaskFolderName.js";
import { formatTaskIdentityPrompt } from "./impl/formatTaskIdentityPrompt.js";
import { taskOrderKeyBetween } from "./impl/taskOrderKeyBetween.js";
import { archiveTaskTool } from "./tools/archive_task.js";
import { createTaskTool } from "./tools/create_task.js";
import { listTasksTool } from "./tools/list_tasks.js";
import { sendTaskMessageTool } from "./tools/send_task_message.js";

/** The latest human sender of each agent's conversation, who owns the tasks that agent creates. */
const OWNER_KEY = "owner";
const ownerSchema = Type.Union([cuid2Schema, Type.Null()]);

/** The catalog manages its tasks' folders; the agent sandbox does not apply to that work. */
const PRODUCT = computePermissions("full_access");

/**
 * Persistent task conversations, each with a dedicated folder and an owner.
 *
 * A task is modeled on a bot: one root agent for its whole life in one folder of its own, with the
 * same identity reservation, folder placement, lifecycle, and messaging. It has no avatar and no
 * administration. It records the person it belongs to and the agent that created it, and it is
 * the root of its own subtasks. Any person may join a task, which puts it in their own list in an
 * order only they control; the owner joins when the task is created.
 */
export class TasksModule implements AgentModule {
    readonly name = "tasks";
    readonly migrations = taskMigrations;

    readonly #abort: AbortModule;
    readonly #compute: ComputeModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #projects: ProjectsModule;
    readonly #runners: RunnersModule;
    readonly #workspaces: WorkspacesModule;
    readonly #listeners = new Set<TaskEventListener>();
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        abort: AbortModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        compute: ComputeModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#abort = abort;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#runners = runners;
        this.#compute = compute;
        this.#durableFunctions = durableFunctions;
        // Archival is committed first; ending the archived agent's machine and background
        // processes follows the commit and survives a restart in between.
        durableFunctions.register({
            name: TASK_ARCHIVE_FUNCTION,
            argumentsSchema: archiveTaskCleanupSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await backoff(ctx, async (attemptCtx) => {
                    const task = await readTaskByAgent(attemptCtx, call.arguments.agentId);
                    if (task?.status === "archived") {
                        await this.#compute.archiveAgent(attemptCtx, task.agentId);
                    }
                });
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const task = await readTaskByAgent(ctx, scope.agent.id);
            if (task === undefined) return "";
            return formatTaskIdentityPrompt(task, this.ownerLabel(task));
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // A task delegates through subtasks, not through more tasks, and a subagent or
            // subtask is one pair of hands inside work it was given.
            if ((await readTaskByAgent(ctx, scope.agent.id)) !== undefined) return [];
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            return [
                createTaskTool(this, scope.agent.id, scope.kv),
                listTasksTool(this, scope.kv),
                sendTaskMessageTool(this, scope.agent.id),
                archiveTaskTool(this, scope.agent.id),
            ];
        },
        // Ownership follows the human whose message the agent is working on, in consumption
        // order. Agent-generated messages never change it; an unidentified human clears it.
        messageAcceptedTransact: async (hookCtx, scope, accepted) => {
            if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata)) {
                return;
            }
            const userId = accepted.metadata?.["userId"];
            const owner = Value.Check(cuid2Schema, userId) ? userId : null;
            if ((await scope.kv.read(hookCtx, OWNER_KEY)) === owner) return;
            await scope.kv.write(hookCtx, OWNER_KEY, owner);
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    onEvent(listener: TaskEventListener): TaskUnsubscribe {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Every task, archived ones included, oldest first. */
    async list(ctx: Context): Promise<readonly TaskRecord[]> {
        return structuredClone(await readTasks(ctx));
    }

    /** The tasks one member joined, in that member's own order. */
    async listForMember(
        ctx: Context,
        memberId: TaskMemberId,
    ): Promise<readonly { readonly task: TaskRecord; readonly membership: TaskMembership }[]> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            const listed: { task: TaskRecord; membership: TaskMembership }[] = [];
            for (const membership of await readMemberships(txCtx, memberId)) {
                const task = await readTask(txCtx, membership.taskId);
                if (task !== undefined) listed.push({ task, membership });
            }
            return structuredClone(listed);
        });
    }

    async membership(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
    ): Promise<TaskMembership | undefined> {
        this.#assertMember(memberId);
        return structuredClone(await readMembership(ctx, taskId, memberId));
    }

    /**
     * Who a person is as a task member. A standalone installation is one person; in team mode a
     * person is their user ID, and without one there is nobody to place the task with.
     */
    memberFor(userId: string | undefined): TaskMemberId | undefined {
        if (!this.#config.configuration.values.feature.team.enabled) return STANDALONE_TASK_MEMBER;
        return userId;
    }

    /**
     * Put the task at the top of the member's list. Joining again changes nothing and reports the
     * existing membership, so a retried join is harmless.
     */
    async join(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
    ): Promise<{ readonly membership: TaskMembership; readonly joined: boolean }> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            await this.#required(txCtx, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing !== undefined) return { membership: existing, joined: false };
            return { membership: await this.#join(txCtx, taskId, memberId), joined: true };
        });
    }

    /** Take the task out of the member's list. Leaving a task one never joined changes nothing. */
    async leave(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
    ): Promise<TaskMembership | undefined> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            await this.#required(txCtx, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing === undefined) return undefined;
            await deleteMembership(txCtx, taskId, memberId);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: Date.now(),
                type: "task_left",
                membership: existing,
            });
            return existing;
        });
    }

    /**
     * Move a task within one member's list, after another task that member joined or first. Only
     * that member's order key changes; every other member's list stays as it was.
     */
    async reorder(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
        afterId: string | null,
    ): Promise<TaskMembership> {
        this.#assertMember(memberId);
        if (afterId === taskId)
            throw new TaskConflictError("A task cannot be placed after itself.");
        return await ctx.inTx(async (txCtx) => {
            await this.#required(txCtx, taskId);
            const current = await readMembership(txCtx, taskId, memberId);
            if (current === undefined) {
                throw new TaskConflictError("Join the task before moving it in your list.");
            }
            const all = await readMemberships(txCtx, memberId);
            const position = all.findIndex((membership) => membership.taskId === taskId);
            // Already in place: a key between the same neighbours would only churn the order.
            if ((afterId === null ? undefined : afterId) === all[position - 1]?.taskId) {
                return current;
            }
            const ordered = all.filter((membership) => membership.taskId !== taskId);
            const afterIndex =
                afterId === null
                    ? -1
                    : ordered.findIndex((membership) => membership.taskId === afterId);
            if (afterId !== null && afterIndex < 0) {
                throw new TaskConflictError("The task to place after is not in your list.");
            }
            const orderKey = taskOrderKeyBetween(
                afterIndex < 0 ? null : (ordered[afterIndex]?.orderKey ?? null),
                ordered[afterIndex + 1]?.orderKey ?? null,
            );
            const moved: TaskMembership = { ...current, orderKey };
            await updateMembershipOrder(txCtx, moved);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: Date.now(),
                type: "task_reordered",
                membership: moved,
            });
            return structuredClone(moved);
        });
    }

    async get(ctx: Context, taskId: string): Promise<TaskRecord | undefined> {
        return structuredClone(await readTask(ctx, taskId));
    }

    async forWorkspace(ctx: Context, workspaceId: string): Promise<TaskRecord | undefined> {
        return structuredClone(await readTaskByWorkspace(ctx, workspaceId));
    }

    async forAgent(ctx: Context, agentId: string): Promise<TaskRecord | undefined> {
        return structuredClone(await readTaskByAgent(ctx, agentId));
    }

    /** Whether a task, its dedicated workspace, or its agent already holds this identity. */
    async hasIdentity(ctx: Context, id: string): Promise<boolean> {
        return (
            (await readTask(ctx, id)) !== undefined ||
            (await readTaskByWorkspace(ctx, id)) !== undefined ||
            (await readTaskByAgent(ctx, id)) !== undefined
        );
    }

    /**
     * The team user an agent's work currently belongs to, read from this module's store for that
     * agent: the latest identified human sender in its conversation, or `undefined` when there is
     * none, as on a standalone installation.
     */
    async ownerFor(ctx: Context, kv: AgentKV): Promise<string | undefined> {
        const owner = await kv.read(ctx, OWNER_KEY);
        if (owner === undefined || owner === null) return undefined;
        if (!Value.Check(ownerSchema, owner)) {
            throw new Error("The stored task owner identity is invalid.");
        }
        return owner;
    }

    /**
     * The owner as the model reads it. Team sender notifications introduce each person by this
     * same installation-local user ID, so the ID alone identifies them without a profile lookup.
     */
    ownerLabel(task: Pick<TaskRecord, "ownerUserId">): string | undefined {
        return task.ownerUserId === undefined ? undefined : `user ID \`${task.ownerUserId}\``;
    }

    /**
     * Create the row, its folder, its ordinary root agent, and the opening message in one
     * database transaction.
     *
     * Every read that justifies the write happens inside that transaction, so the identities and
     * the folder name it settles on cannot go stale before the insert. The folder is made after
     * the row: a name the database refuses aborts the transaction before anything reaches disk.
     */
    async create(ctx: Context, input: CreateTaskInput): Promise<TaskRecord> {
        return (await this.createWithResult(ctx, input)).task;
    }

    /** Reports creation inside its transaction so a retry cannot repeat post-creation work. */
    async createWithResult(ctx: Context, input: CreateTaskInput): Promise<TaskCreation> {
        if (!Value.Check(createTaskInputSchema, input)) throw new TaskInputError();
        if (input.text !== undefined && input.creatorAgentId === undefined) {
            throw new TaskInputError("An opening message needs the agent that sends it.");
        }
        return await ctx.inTx(async (txCtx) => {
            if (input.id !== undefined) {
                const existing = await readTask(txCtx, input.id);
                if (existing !== undefined) {
                    if (
                        (input.workspaceId !== undefined &&
                            input.workspaceId !== existing.workspaceId) ||
                        (input.agentId !== undefined && input.agentId !== existing.agentId)
                    ) {
                        throw new TaskConflictError(
                            "The requested identities do not match this task.",
                            existing,
                        );
                    }
                    return { task: structuredClone(existing), created: false };
                }
            }
            const agents = this.#requireAgents();
            const supplied = [input.id, input.workspaceId, input.agentId].filter(
                (id) => id !== undefined,
            );
            const reserved = new Set(supplied);
            if (reserved.size !== supplied.length) {
                throw new TaskConflictError(
                    "The task, workspace, and agent must have distinct identities.",
                );
            }
            for (const id of reserved) {
                if (await this.#identityInUse(txCtx, id)) {
                    throw new TaskConflictError("A requested identity is already in use.");
                }
            }
            const taskId = input.id ?? (await this.#unusedIdentity(txCtx, reserved));
            reserved.add(taskId);
            const workspaceId = input.workspaceId ?? (await this.#unusedIdentity(txCtx, reserved));
            reserved.add(workspaceId);
            const agentId = input.agentId ?? (await this.#unusedIdentity(txCtx, reserved));
            const folderName = await this.#chooseFolderName(txCtx, input.name, input.folderName);
            // A task's folder goes where a bot's would: the default runner once runners are
            // configured, otherwise this installation's public folder.
            const runnerId = this.#runners.enabled ? this.#runners.defaultRunnerId : undefined;
            const path = this.#taskPath(runnerId, folderName);
            const now = Date.now();
            const config: AgentConfig = {
                provenance: { createdAt: now },
                environment: {
                    ...currentAgentEnvironment(),
                    workingDirectory: path,
                },
                // A task's conversation is the task, so it is called what the task is called
                // and automatic naming never writes over it.
                metadata: { title: input.name, updatedAt: now, version: 1 },
                modules: {
                    compute: {
                        cwd: path,
                        ...(runnerId === undefined ? {} : { runnerId }),
                        secretScope: { workspaceId },
                    },
                },
            };
            await agents.create(txCtx, config, { id: agentId, parent: null });
            const task: TaskRecord = {
                id: taskId,
                name: input.name,
                folderName,
                ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
                ...(input.creatorAgentId === undefined
                    ? {}
                    : { creatorAgentId: input.creatorAgentId }),
                workspaceId,
                workspaceVersion: 1,
                workspaceUpdatedAt: now,
                agentId,
                path,
                ...(runnerId === undefined ? {} : { runnerId }),
                status: "active",
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            await insertTask(txCtx, task);
            // The unique folder, path, workspace, and agent columns have accepted this task by
            // now. An existing directory is the folder of a creation that was rolled back after
            // making it, and is taken up again.
            const machine = await this.#runners.machine(runnerId);
            const existingFolder = await machine.fs
                .stat(PRODUCT, path)
                .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return undefined;
                    throw error;
                });
            if (existingFolder !== undefined && !existingFolder.isDirectory) {
                throw new TaskConflictError("The task folder path is already in use.");
            }
            await machine.fs.mkdir(PRODUCT, path, { recursive: true });
            if (input.text !== undefined && input.creatorAgentId !== undefined) {
                // The agent ID doubles as the opening message's identity: it is new, and it is
                // never reused, so the opening is delivered exactly once with the task.
                await this.#deliver(txCtx, input.creatorAgentId, task, input.text, agentId);
            }
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "task_created",
                task,
            });
            // The owner finds the new task at the top of their own list.
            const owner = this.memberFor(input.ownerUserId);
            if (owner !== undefined) await this.#join(txCtx, taskId, owner);
            return { task: structuredClone(task), created: true };
        });
    }

    /**
     * Deliver one message into the task's conversation. It queues behind the current run and
     * starts one when the task is idle. The caller-supplied message ID makes redelivery after an
     * interruption idempotent.
     */
    async sendMessage(
        ctx: Context,
        fromAgentId: string,
        taskId: string,
        text: string,
        messageId: string,
    ): Promise<TaskRecord> {
        const task = await this.#required(ctx, taskId);
        if (task.status === "archived") {
            throw new TaskConflictError("The task is archived and cannot receive messages.");
        }
        if (task.agentId === fromAgentId) {
            throw new TaskConflictError("A task cannot send a message to itself.");
        }
        await this.#deliver(ctx, fromAgentId, task, text, messageId);
        return structuredClone(task);
    }

    /** Renames the task and its conversation together. The folder and identities do not move. */
    async rename(
        ctx: Context,
        taskId: string,
        name: string,
        expectedVersion: number,
    ): Promise<TaskRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, taskId);
            this.#assertVersion(current, expectedVersion);
            if (current.name === name) return current;
            await this.#updateAgentMetadata(txCtx, current.agentId, { title: name });
            return await this.#change(txCtx, current, (task) => ({ ...task, name }));
        });
    }

    /**
     * Archive the task: stop its work, archive its agent, and record durable cleanup of the
     * agent's machine, all in one transaction. The folder stays on disk and history stays
     * readable; archival is logical, never a deletion.
     */
    async archive(ctx: Context, taskId: string, expectedVersion: number): Promise<TaskRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, taskId);
            this.#assertVersion(current, expectedVersion);
            return await this.#archive(txCtx, current);
        });
    }

    /** Archive through the tool: only the agent that created the task may do this. */
    async archiveForAgent(
        ctx: Context,
        actingAgentId: string,
        taskId: string,
    ): Promise<TaskRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, taskId);
            if (current.creatorAgentId !== actingAgentId) {
                throw new TaskConflictError("Only the agent that created a task may archive it.");
            }
            return await this.#archive(txCtx, current);
        });
    }

    async unarchive(ctx: Context, taskId: string, expectedVersion: number): Promise<TaskRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, taskId);
            this.#assertVersion(current, expectedVersion);
            if (current.status === "active") return current;
            await this.#durableFunctions.cancel(txCtx, `task-archive:${current.agentId}`);
            await this.#updateAgentMetadata(txCtx, current.agentId, { archivedAt: null });
            return await this.#change(txCtx, current, (task) => {
                const active: TaskRecord = { ...task, status: "active" };
                delete active.archivedAt;
                return active;
            });
        });
    }

    async #archive(ctx: Context, current: TaskRecord): Promise<TaskRecord> {
        if (current.status === "archived") return current;
        const now = Date.now();
        await this.#abort.abort(ctx, current.agentId);
        await this.#updateAgentMetadata(ctx, current.agentId, { archivedAt: now });
        await this.#durableFunctions.invoke(ctx, {
            function: TASK_ARCHIVE_FUNCTION,
            arguments: { agentId: current.agentId },
            operationId: `task-archive:${current.agentId}`,
            lockKeys: [`task:${current.agentId}`],
        });
        return await this.#change(ctx, current, (task) => ({
            ...task,
            status: "archived",
            archivedAt: now,
        }));
    }

    async #join(ctx: Context, taskId: string, memberId: TaskMemberId): Promise<TaskMembership> {
        const first = (await readMemberships(ctx, memberId))[0];
        const membership: TaskMembership = {
            taskId,
            memberId,
            orderKey: taskOrderKeyBetween(null, first?.orderKey ?? null),
            joinedAt: Date.now(),
        };
        await insertMembership(ctx, membership);
        this.#publish(ctx, {
            eventId: globalThis.crypto.randomUUID(),
            at: membership.joinedAt,
            type: "task_joined",
            membership,
        });
        return structuredClone(membership);
    }

    #assertMember(memberId: TaskMemberId): void {
        if (!Value.Check(taskMemberIdSchema, memberId)) {
            throw new TaskInputError("The task member is invalid.");
        }
    }

    async #deliver(
        ctx: Context,
        fromAgentId: string,
        task: TaskRecord,
        text: string,
        messageId: string,
    ): Promise<void> {
        const accepted = await this.#requireAgents().send(
            ctx,
            task.agentId,
            {
                role: "agent",
                author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                content: [{ type: "text", text: `Message from agent ${fromAgentId}:\n\n${text}` }],
            },
            {
                id: messageId,
                metadata: {
                    tasks: { fromAgentId, taskId: task.id },
                    ...senderAgentIdMetadata(fromAgentId),
                },
            },
        );
        if (accepted.id !== messageId) {
            throw new Error("Agent Base did not preserve the requested message ID.");
        }
    }

    /** A task's folder on the machine it goes to. */
    #taskPath(runnerId: string | undefined, folderName: string): string {
        if (runnerId === undefined) return this.#config.taskPath(folderName);
        const home = this.#runners.home(runnerId);
        if (home === undefined) {
            throw new RunnerUnavailableError(
                `The runner ${this.#runners.displayName(runnerId)} has never connected, so it has nowhere to put a task's folder yet.`,
            );
        }
        return this.#config.taskPathOn(
            home,
            this.#runners.platform(runnerId) ?? "linux",
            folderName,
        );
    }

    /**
     * Apply one decided change to a task read in this same transaction. The stored version is
     * asserted again by the update itself, so a row that moved in between is refused.
     */
    async #change(
        ctx: Context,
        current: TaskRecord,
        decide: (task: TaskRecord) => TaskRecord | undefined,
    ): Promise<TaskRecord> {
        const decided = decide(structuredClone(current));
        if (decided === undefined) return current;
        const next: TaskRecord = {
            ...decided,
            version: current.version + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        };
        if (next.status !== current.status || next.archivedAt !== current.archivedAt) {
            next.workspaceVersion = current.workspaceVersion + 1;
            next.workspaceUpdatedAt = next.updatedAt;
        }
        if (!Value.Check(taskRecordSchema, next)) throw new Error("The task mutation is invalid.");
        const stored = await updateTask(ctx, next, current.version);
        this.#publish(ctx, {
            eventId: globalThis.crypto.randomUUID(),
            at: stored.updatedAt,
            type: "task_updated",
            task: stored,
            previousTask: current,
        });
        return stored;
    }

    /** Write task-owned agent metadata, advancing the agent's own version and timestamp. */
    async #updateAgentMetadata(
        ctx: Context,
        agentId: string,
        update: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const config = await agents.config(ctx, agentId);
        if (config === undefined) throw new Error("The task agent was not found.");
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, agentId, { ...update, updatedAt: Date.now(), version });
    }

    async #chooseFolderName(ctx: Context, name: string, supplied?: string): Promise<string> {
        if (supplied !== undefined) {
            if ((await readTaskByFolderName(ctx, supplied)) !== undefined) {
                throw new TaskConflictError("That task folder name is already in use.");
            }
            return supplied;
        }
        const base = deriveTaskFolderName(name);
        for (let suffix = 1; suffix < 1_000_000; suffix += 1) {
            const tail = suffix === 1 ? "" : `_${String(suffix)}`;
            const folderName = `${base.slice(0, 64 - tail.length)}${tail}`;
            if ((await readTaskByFolderName(ctx, folderName)) === undefined) return folderName;
        }
        throw new TaskConflictError("A unique task folder name could not be chosen.");
    }

    async #unusedIdentity(ctx: Context, excluded: ReadonlySet<string>): Promise<string> {
        for (;;) {
            const id = createId();
            if (excluded.has(id)) continue;
            if (await this.#identityInUse(ctx, id)) continue;
            return id;
        }
    }

    async #identityInUse(ctx: Context, id: string): Promise<boolean> {
        return (
            (await this.hasIdentity(ctx, id)) ||
            (await this.#requireAgents().config(ctx, id)) !== undefined ||
            (await this.#projects.get(ctx, id)) !== undefined ||
            (await this.#workspaces.hasIdentity(ctx, id))
        );
    }

    async #required(ctx: Context, taskId: string): Promise<TaskRecord> {
        const task = await readTask(ctx, taskId);
        if (task === undefined) throw new TaskNotFoundError();
        return task;
    }

    #assertVersion(task: TaskRecord, expectedVersion: number): void {
        if (task.version !== expectedVersion) throw new TaskConflictError("The task has changed.");
    }

    #publish(ctx: Context, event: TaskEvent): void {
        if (!Value.Check(taskEventSchema, event)) throw new Error("The task event is invalid.");
        const frozen = deepFreeze(structuredClone(event)) as TaskEvent;
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of [...this.#listeners]) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A task subscriber failed.",
                        { eventId: frozen.eventId },
                        error,
                    );
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The tasks module has not started.");
        return this.#agents;
    }
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}
