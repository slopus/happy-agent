import { AsyncResource } from "node:async_hooks";
import { basename } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    cuid2Schema,
    currentAgentEnvironment,
    type AgentBaseAcceptedMessage,
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
import { type MessageMode } from "@slopus/happy-agent-client";
import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { afterCommit, backoff, type Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import type { BotSettingsModule } from "../botSettings/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProjectsModule } from "../projects/index.js";
import type { RunnersModule } from "../runners/index.js";
import { MAX_NAMING_MESSAGE_CHARS, TitlesModule } from "../titles/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { agentDeliveryMode } from "../impl/agentDeliveryMode.js";
import type { HistoryModule } from "../history/index.js";
import {
    isUserOriginMetadata,
    senderAgentExplanationFromTitle,
    senderAgentExplanationMetadata,
    senderAgentIdMetadata,
} from "../impl/messageOrigin.js";
import { mutationIdMetadata } from "../impl/mutationEcho.js";
import { runNamingAttempts } from "../impl/runNamingAttempts.js";

import {
    archiveTaskCleanupSchema,
    createTaskInputSchema,
    STANDALONE_TASK_MEMBER,
    taskMemberIdSchema,
    taskMembershipUnreadSchema,
    taskNameSchema,
    taskRecordSchema,
    TASK_ARCHIVE_FUNCTION,
    TASK_PLACEHOLDER_NAME,
    TaskConflictError,
    TaskInputError,
    TaskNotFoundError,
    type CreateTaskInput,
    type TaskCreation,
    type TaskMemberId,
    type TaskMembership,
    type TaskMembershipUnread,
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
    deleteTask,
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
    updateMembershipUnread,
    updateTask,
} from "./TaskStore.js";
import { deriveTaskFolderName } from "./impl/deriveTaskFolderName.js";
import {
    clearTaskLeave,
    queryAutomaticTaskIds,
    queryFirstTaskOrderKey,
    saveTaskLeave,
} from "./persistence/taskAutomaticMembership.js";
import { formatTaskIdentityPrompt } from "./impl/formatTaskIdentityPrompt.js";
import { taskOrderKeyBetween } from "./impl/taskOrderKeyBetween.js";
import { archiveTaskTool } from "./tools/archive_task.js";
import { createTaskTool } from "./tools/create_task.js";
import { listTasksTool } from "./tools/list_tasks.js";
import { sendTaskMessageTool } from "./tools/send_task_message.js";

/** The latest human sender of each agent's conversation, who owns the tasks that agent creates. */
const OWNER_KEY = "owner";
/** Marks a task agent's conversation once its first message has started naming the task. */
const NAME_ATTEMPTED_KEY = "task-name-attempted";
const NAMING_FUNCTION = "tasks.name";
const namingArgumentsSchema = Type.Object({
    taskId: cuid2Schema,
    providerId: Type.String(),
    modelId: Type.Optional(Type.String()),
    message: Type.String({ minLength: 1, maxLength: MAX_NAMING_MESSAGE_CHARS }),
});
const ownerSchema = Type.Union([cuid2Schema, Type.Null()]);

/** The catalog manages its tasks' folders; the agent sandbox does not apply to that work. */
const PRODUCT = computePermissions("full_access");
/** How an agent that manages tasks mentions one, so people see its live name as a link. */
const TASK_REFERENCE_INSTRUCTIONS =
    'When you mention a task in a reply, write <happy-agent id="…"/> with the task\'s agent ID, not its task ID; people see its live name as a link. The task tools give you the exact tag.';

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
    readonly #backgroundScope = new AsyncResource("happy-agent-task-naming");
    readonly #compute: ComputeModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #projects: ProjectsModule;
    readonly #runners: RunnersModule;
    readonly #titles: TitlesModule;
    readonly #workspaces: WorkspacesModule;
    readonly #collaboration: CollaborationModule;
    readonly #transactionalListeners = new Set<TaskEventListener>();
    readonly #listeners = new Set<TaskEventListener>();
    readonly #botSettings: BotSettingsModule | undefined;
    /** The mutation the sending run answers, carried on each message into a task. */
    readonly #history: HistoryModule | undefined;
    #agents: AgentSystemRef | undefined;
    #closed = false;

    constructor(
        config: ConfigModule,
        abort: AbortModule,
        titles: TitlesModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        compute: ComputeModule,
        durableFunctions: DurableFunctionsModule,
        collaboration: CollaborationModule,
        botSettings?: BotSettingsModule,
        history?: HistoryModule,
    ) {
        this.#collaboration = collaboration;
        this.#history = history;
        this.#botSettings = botSettings;
        this.#config = config;
        this.#abort = abort;
        this.#titles = titles;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#runners = runners;
        this.#compute = compute;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: NAMING_FUNCTION,
            argumentsSchema: namingArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    const { taskId, providerId, modelId, message } = call.arguments;
                    const initial = await readTask(ctx, taskId);
                    if (
                        initial === undefined ||
                        initial.nameConfigured ||
                        initial.status !== "active"
                    )
                        return null;
                    const style = await this.#titles.namingStyle(ctx, initial.agentId);
                    const name = await runNamingAttempts(
                        ctx,
                        call.kv,
                        async () => {
                            const current = await readTask(ctx, taskId);
                            return (
                                current !== undefined &&
                                !current.nameConfigured &&
                                current.status === "active"
                            );
                        },
                        async () => {
                            return (
                                await this.#titles.suggestNames(
                                    ctx,
                                    {
                                        firstMessage: message,
                                        wanted: { title: true },
                                        providerId,
                                        ...(modelId === undefined ? {} : { modelId }),
                                        style,
                                    },
                                    ctx.lifetime === undefined ? {} : { signal: ctx.lifetime },
                                )
                            ).title;
                        },
                    );
                    if (name === null) return null;
                    const chosen = name ?? this.#titles.fallbackName(message, style);
                    const title = chosen
                        ?.split(/\s+/u)
                        .slice(0, 6)
                        .join(" ")
                        .slice(0, 60)
                        .trimEnd();
                    ctx.lifetime?.throwIfAborted();
                    if (title === undefined || !Value.Check(taskNameSchema, title)) return null;
                    await ctx.inTx(async (txCtx) => {
                        const current = await this.#required(txCtx, taskId);
                        if (current.nameConfigured || current.status !== "active") return;
                        await this.#updateAgentMetadata(txCtx, current.agentId, { title });
                        await this.#change(txCtx, current, (value) => ({
                            ...value,
                            name: title,
                            nameConfigured: true,
                        }));
                    });
                    return null;
                }),
        });
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

    /**
     * Tasks belong to the conversation a person is having, outside any one tree, so a subagent
     * or subtask never manages them and neither does an agent whose bot keeps it inside its tree.
     */
    async #offersTools(ctx: Context, agentId: string): Promise<boolean> {
        if ((await this.#requireAgents().parentOf(ctx, agentId)) !== null) return false;
        return (await this.#botSettings?.allowsCrossWorkspace(ctx, agentId)) ?? true;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const task = await readTaskByAgent(ctx, scope.agent.id);
            if (task !== undefined) return formatTaskIdentityPrompt(task, this.ownerLabel(task));
            // Only the agents offered the task tools hear how to mention a task.
            if (!(await this.#offersTools(ctx, scope.agent.id))) return "";
            return TASK_REFERENCE_INSTRUCTIONS;
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // A task delegates through subtasks, not through more tasks, and a subagent or
            // subtask is one pair of hands inside work it was given.
            if ((await readTaskByAgent(ctx, scope.agent.id)) !== undefined) return [];
            if (!(await this.#offersTools(ctx, scope.agent.id))) return [];
            const creator = { provider: scope.agent.provider, model: scope.agent.model };
            return [
                createTaskTool(
                    this,
                    this.#collaboration,
                    scope.agent.id,
                    scope.kv,
                    creator,
                    scope.agent.permissionMode,
                    await this.#collaboration.shownAgentOptions(ctx, scope.kv, creator),
                ),
                listTasksTool(this, scope.kv),
                sendTaskMessageTool(this, scope.agent.id),
                archiveTaskTool(this, scope.agent.id),
            ];
        },
        messageAcceptedTransact: async (hookCtx, scope, accepted) => {
            // An unnamed task takes its name from the first request it is given: a person's
            // message, or the opening message from the agent that created it.
            const task = await readTaskByAgent(hookCtx, scope.agent.id);
            if (task !== undefined) {
                if (task.nameConfigured) return;
                const message = namingText(accepted, task);
                if (message.length === 0) return;
                if ((await scope.kv.read(hookCtx, NAME_ATTEMPTED_KEY)) !== undefined) return;
                await scope.kv.write(hookCtx, NAME_ATTEMPTED_KEY, { at: Date.now() });
                await this.#durableFunctions.invoke(hookCtx, {
                    function: NAMING_FUNCTION,
                    operationId: `tasks.name:${task.id}`,
                    arguments: {
                        taskId: task.id,
                        providerId: scope.agent.provider,
                        ...(scope.agent.model === undefined ? {} : { modelId: scope.agent.model }),
                        message,
                    },
                });
                return;
            }
            // Ownership follows the human whose message the agent is working on, in consumption
            // order. Agent-generated messages never change it; an unidentified human clears it.
            if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata)) {
                return;
            }
            const userId = accepted.metadata?.["userId"];
            const owner = Value.Check(cuid2Schema, userId) ? userId : null;
            if ((await scope.kv.read(hookCtx, OWNER_KEY)) === owner) return;
            await scope.kv.write(hookCtx, OWNER_KEY, owner);
        },
    };

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /** Release module references; Durable Functions owns pending naming and its shutdown. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#backgroundScope.emitDestroy();
    }

    onEventTransactional(listener: TaskEventListener): TaskUnsubscribe {
        this.#transactionalListeners.add(listener);
        return () => this.#transactionalListeners.delete(listener);
    }

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
            await clearTaskLeave(txCtx, memberId, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing !== undefined) return { membership: existing, joined: false };
            return { membership: await this.#join(txCtx, taskId, memberId), joined: true };
        });
    }

    /**
     * An agent looped this member into an active task: they join it, whatever their automatic
     * joining says, and it is marked unread for them with the agent's reason. A member already in
     * the task keeps their place and is marked unread again.
     */
    async loopIn(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
        input: { readonly agentId: string; readonly note: string },
    ): Promise<{ readonly membership: TaskMembership; readonly joined: boolean }> {
        this.#assertMember(memberId);
        const unread: TaskMembershipUnread = {
            reason: "looped_in",
            since: Date.now(),
            agentId: input.agentId,
            note: input.note,
        };
        if (!Value.Check(taskMembershipUnreadSchema, unread)) {
            throw new TaskInputError("The reason for looping someone in is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            const task = await this.#required(txCtx, taskId);
            if (task.status !== "active") {
                throw new TaskConflictError("Archived tasks cannot take new people.", task);
            }
            await clearTaskLeave(txCtx, memberId, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing === undefined) {
                return {
                    membership: await this.#join(txCtx, taskId, memberId, unread),
                    joined: true,
                };
            }
            return { membership: await this.#updateUnread(txCtx, existing, unread), joined: false };
        });
    }

    /** The member looked at the task: clear what was unread. Already read changes nothing. */
    async markRead(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
    ): Promise<TaskMembership | undefined> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            await this.#required(txCtx, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing === undefined || existing.unread === undefined) {
                return structuredClone(existing);
            }
            return await this.#updateUnread(txCtx, existing, undefined);
        });
    }

    async #updateUnread(
        ctx: Context,
        membership: TaskMembership,
        unread: TaskMembershipUnread | undefined,
    ): Promise<TaskMembership> {
        const { unread: _previous, ...rest } = membership;
        const updated: TaskMembership = unread === undefined ? rest : { ...rest, unread };
        await updateMembershipUnread(ctx, updated);
        await this.#publish(ctx, {
            eventId: globalThis.crypto.randomUUID(),
            at: Date.now(),
            type: "task_membership_updated",
            membership: updated,
        });
        return structuredClone(updated);
    }

    /** Join a bounded batch of eligible tasks without undoing explicit leaves or reordering. */
    async joinAutomatically(
        ctx: Context,
        memberId: TaskMemberId,
        taskId?: string,
    ): Promise<number> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            const ids = await queryAutomaticTaskIds(txCtx, memberId, taskId);
            for (const id of ids) await this.#join(txCtx, id, memberId);
            return ids.length;
        });
    }

    /** Take the task out of the member's list and suppress future automatic joining. */
    async leave(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
    ): Promise<TaskMembership | undefined> {
        this.#assertMember(memberId);
        return await ctx.inTx(async (txCtx) => {
            await this.#required(txCtx, taskId);
            await saveTaskLeave(txCtx, memberId, taskId);
            const existing = await readMembership(txCtx, taskId, memberId);
            if (existing === undefined) return undefined;
            await deleteMembership(txCtx, taskId, memberId);
            await this.#publish(txCtx, {
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
            await this.#publish(txCtx, {
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
            const name = input.name ?? TASK_PLACEHOLDER_NAME;
            const folderName = await this.#chooseFolderName(
                txCtx,
                input.name ?? "task",
                input.folderName,
            );
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
                // and chat naming never writes over it; an unnamed task names both itself.
                metadata: {
                    title: name,
                    updatedAt: now,
                    version: 1,
                    ...(input.mode !== undefined && input.text === undefined
                        ? {
                              initialMode: input.mode,
                              ...(input.ownerUserId === undefined
                                  ? {
                                        draft: {
                                            effort: input.mode.effort,
                                            modelId: input.mode.modelId,
                                            permissionMode: input.mode.permissionMode,
                                            providerId: input.mode.providerId,
                                            serviceTier: input.mode.serviceTier,
                                            text: "",
                                        },
                                        draftUpdatedAt: now,
                                    }
                                  : {}),
                          }
                        : {}),
                },
                modules: {
                    compute: {
                        cwd: path,
                        ...(runnerId === undefined ? {} : { runnerId }),
                        secretScope: { workspaceId },
                    },
                },
            };
            await agents.create(txCtx, config, { id: agentId, parent: null });
            // A task an agent opens stays under whatever governs that agent: a bot's settings
            // must not be escaped by working through a task the bot made.
            if (input.creatorAgentId !== undefined) {
                await this.#botSettings?.adoptRoot(txCtx, agentId, input.creatorAgentId);
            }
            const task: TaskRecord = {
                id: taskId,
                name,
                nameConfigured: input.name !== undefined,
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
                await this.#deliver(
                    txCtx,
                    input.creatorAgentId,
                    task,
                    input.text,
                    agentId,
                    input.mode,
                    // The opening message's row says what the task was created to do.
                    senderAgentExplanationFromTitle(input.name),
                );
            }
            await this.#publish(txCtx, {
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
     * interruption idempotent. The sender's explanation, when given, is the line a person sees
     * for the message before opening it.
     */
    async sendMessage(
        ctx: Context,
        fromAgentId: string,
        taskId: string,
        text: string,
        messageId: string,
        explanation?: string,
    ): Promise<TaskRecord> {
        const task = await this.#required(ctx, taskId);
        if (task.status === "archived") {
            throw new TaskConflictError("The task is archived and cannot receive messages.");
        }
        if (task.agentId === fromAgentId) {
            throw new TaskConflictError("A task cannot send a message to itself.");
        }
        await this.#deliver(ctx, fromAgentId, task, text, messageId, undefined, explanation);
        return structuredClone(task);
    }

    /**
     * Renames the task and its conversation together. The folder and identities do not move. A
     * rename is a decision, so it also ends automatic naming, even when the name is unchanged.
     */
    async rename(
        ctx: Context,
        taskId: string,
        name: string,
        expectedVersion: number,
    ): Promise<TaskRecord> {
        if (!Value.Check(taskNameSchema, name)) {
            throw new TaskInputError("The task name must be a short, nonblank line of text.");
        }
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, taskId);
            this.#assertVersion(current, expectedVersion);
            if (current.name === name && current.nameConfigured) return current;
            if (current.name !== name) {
                await this.#updateAgentMetadata(txCtx, current.agentId, { title: name });
            }
            return await this.#change(txCtx, current, (task) => ({
                ...task,
                name,
                nameConfigured: true,
            }));
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

    /**
     * Delete an archived task for good: its folder, then its row with every membership and
     * recorded leave, publishing `task_deleted`. Its agent is not touched here; whoever deletes the
     * task erases that first. Repeating this once the task is gone does nothing.
     */
    async purge(ctx: Context, taskId: string): Promise<void> {
        const task = await readTask(ctx, taskId);
        if (task === undefined) return;
        if (task.status !== "archived") {
            throw new TaskConflictError("Only an archived task can be deleted.");
        }
        if (basename(task.path) !== task.folderName) {
            throw new TaskConflictError("The task's folder does not match its folder name.");
        }
        const machine = await this.#runners.machine(task.runnerId);
        await machine.fs.rm(PRODUCT, task.path, { force: true, recursive: true });
        await ctx.inTx(async (txCtx) => {
            const current = await readTask(txCtx, taskId);
            if (current === undefined) return;
            await this.#durableFunctions.cancel(txCtx, `task-archive:${current.agentId}`);
            await deleteTask(txCtx, taskId);
            await this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: Math.max(Date.now(), current.updatedAt + 1),
                type: "task_deleted",
                task: current,
            });
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

    async #join(
        ctx: Context,
        taskId: string,
        memberId: TaskMemberId,
        unread?: TaskMembershipUnread,
    ): Promise<TaskMembership> {
        const firstOrderKey = await queryFirstTaskOrderKey(ctx, memberId);
        const membership: TaskMembership = {
            taskId,
            memberId,
            orderKey: taskOrderKeyBetween(null, firstOrderKey ?? null),
            joinedAt: Date.now(),
            ...(unread === undefined ? {} : { unread }),
        };
        await insertMembership(ctx, membership);
        await this.#publish(ctx, {
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

    /**
     * Put one agent's message in the task's conversation. A task that has never been given a mode,
     * including one created before this rule, takes the sender's selection with the message and
     * records it as its last mode, so its first turn has a model to run on.
     */
    async #deliver(
        ctx: Context,
        fromAgentId: string,
        task: TaskRecord,
        text: string,
        messageId: string,
        explicitMode?: MessageMode,
        explanation?: string,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const mutationId = await this.#history?.runMutationId(ctx, fromAgentId);
        await ctx.inTx(async (txCtx) => {
            const config = await agents.config(txCtx, task.agentId);
            const hasInitialMode =
                config?.metadata?.["initialMode"] !== undefined &&
                config?.metadata?.["initialMode"] !== null;
            const delivery =
                explicitMode !== undefined
                    ? {
                          mode: explicitMode,
                          options: {
                              effort: explicitMode.effort as SessionReasoningEffort,
                              model: explicitMode.modelId,
                              permissionMode: explicitMode.permissionMode,
                              provider: explicitMode.providerId,
                              serviceTier: explicitMode.serviceTier as SessionServiceTier,
                          },
                      }
                    : await agentDeliveryMode(txCtx, agents, this.#config.models, task.agentId);
            const accepted = await agents.send(
                txCtx,
                task.agentId,
                {
                    role: "agent",
                    author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                    content: [
                        { type: "text", text: `Message from agent ${fromAgentId}:\n\n${text}` },
                    ],
                },
                {
                    id: messageId,
                    metadata: {
                        tasks: { fromAgentId, taskId: task.id },
                        ...senderAgentIdMetadata(fromAgentId),
                        ...(explanation === undefined
                            ? {}
                            : senderAgentExplanationMetadata(explanation)),
                        ...(delivery === undefined ? {} : { mode: delivery.mode }),
                        ...mutationIdMetadata(mutationId),
                    },
                    ...delivery?.options,
                },
            );
            if (accepted.id !== messageId) {
                throw new Error("Agent Base did not preserve the requested message ID.");
            }
            if (delivery !== undefined || hasInitialMode) {
                await this.#updateAgentMetadata(txCtx, task.agentId, {
                    ...(delivery === undefined ? {} : { lastMode: delivery.mode }),
                    initialMode: null,
                });
            }
        });
    }

    /** A task's folder on the machine it goes to. */
    #taskPath(runnerId: string | undefined, folderName: string): string {
        if (runnerId === undefined) {
            // A workload user's runner holds this machine's folders under that user's home.
            const local = this.#runners.machineHome(undefined);
            return local === undefined
                ? this.#config.taskPath(folderName)
                : this.#config.taskPathOn(local.home, local.platform, folderName);
        }
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
        await this.#publish(ctx, {
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

    async #publish(ctx: Context, event: TaskEvent): Promise<void> {
        if (!Value.Check(taskEventSchema, event)) throw new Error("The task event is invalid.");
        const frozen = deepFreeze(structuredClone(event)) as TaskEvent;
        // Reserve the catalog event's place before transactional listeners publish memberships.
        // All callbacks are still discarded if any part of the transaction rolls back.
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
        for (const listener of [...this.#transactionalListeners]) {
            await listener(ctx, frozen);
        }
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The tasks module has not started.");
        return this.#agents;
    }
}

/**
 * The text a task is named from: a person's message, or a message this module delivered into the
 * task from another agent, without the sender line it adds. Media and model-only blocks are left
 * out, and system or service messages name nothing.
 */
function namingText(accepted: AgentBaseAcceptedMessage, task: TaskRecord): string {
    const delivered = accepted.metadata?.["tasks"];
    const fromAgent =
        accepted.message.role === "agent" &&
        typeof delivered === "object" &&
        delivered !== null &&
        (delivered as Record<string, unknown>)["taskId"] === task.id;
    if (accepted.message.role !== "user" && !fromAgent) return "";
    const text = accepted.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
    return (fromAgent ? text.replace(/^Message from agent [a-z0-9]+:\s*/u, "") : text)
        .trim()
        .slice(-MAX_NAMING_MESSAGE_CHARS);
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}
