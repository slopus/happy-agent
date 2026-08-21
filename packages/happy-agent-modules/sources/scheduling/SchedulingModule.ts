import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";

import { senderAgentIdMetadata } from "../impl/messageOrigin.js";
import {
    MAX_SCHEDULING_FAILURE_LENGTH,
    MAX_SCHEDULING_MESSAGE_LENGTH,
    MAX_SCHEDULING_PAGE_SIZE,
    schedulingAgentIdSchema,
    schedulingCancelInputSchema,
    schedulingMessageIdSchema,
    schedulingScheduleInputSchema,
    schedulingSchedulePageQuerySchema,
    schedulingTimestampSchema,
    schedulingWaitInputSchema,
    schedulingWaitUntilInputSchema,
    type SchedulingCancelInput,
    type SchedulingScheduleInput,
    type SchedulingSchedulePage,
    type SchedulingSchedulePageQuery,
    type SchedulingScheduledMessage,
    type SchedulingWaitInput,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitUntilInput,
    type SchedulingWaitingRecord,
} from "./Scheduling.js";
import {
    schedulingEventListenerSchema,
    schedulingEventSchema,
    type SchedulingEvent,
    type SchedulingEventListener,
    type SchedulingUnsubscribe,
} from "./SchedulingEvent.js";
import {
    assertSchedulingPage,
    assertSchedulingScheduledMessage,
    assertSchedulingWaitRecord,
    assertSchedulingWaitResult,
    MAX_SCHEDULING_RECOVERY_BATCH,
    type SchedulingStore,
} from "./SchedulingStore.js";
import { SchedulingSuspensions } from "./SchedulingSuspensions.js";
import { SchedulingAlarm } from "./SchedulingAlarm.js";
import { cancellationText, schedulePageText, scheduleText, waitText } from "./schedulingFormat.js";
import { durationMilliseconds, humanDuration, instantMilliseconds } from "./schedulingTime.js";
import { createSqliteSchedulingStorage, schedulingMigrations } from "./SqliteSchedulingStorage.js";
import { cancelScheduledMessageTool } from "./tools/cancel_scheduled_message.js";
import { listScheduledMessagesTool } from "./tools/list_scheduled_messages.js";
import { scheduleMessageTool } from "./tools/schedule_message.js";
import { waitTool } from "./tools/wait.js";
import { waitUntilTool } from "./tools/wait_until.js";

const DAY = 24 * 60 * 60 * 1_000;

/** The longest a single `wait` or `wait_until` may hold an agent. */
export const MAX_SCHEDULING_WAIT_DURATION = DAY;
/** The furthest ahead a message may be scheduled. */
export const MAX_SCHEDULING_HORIZON = DAY;
/** How many scheduled messages one page returns when the caller does not ask for fewer. */
export const SCHEDULING_PAGE_SIZE = 50;
/** The character budget every model-facing scheduling result is trimmed to fit. */
export const SCHEDULING_OUTPUT_CHARACTERS = 8_000;

/**
 * Waiting, and messages that arrive later.
 *
 * Scheduling keeps its own time. Nothing outside it holds the alarms, decides when a message is
 * due, or performs the delivery: the module writes a durable row, arms its own timer, and when
 * that timer fires it puts the message in the recipient's inbox itself through the agent
 * collection. A restart re-arms every pending row from the table, which is the only place the
 * work is really recorded — the timers are just this process's memory of it.
 *
 * A wait is the same idea seen from the other side. The row says what is being waited for and
 * until when; the suspension holding the tool call is ephemeral. Any message into the agent's
 * chat ends the wait early, and the model is told how much time really passed rather than how
 * much it asked for.
 */
export class SchedulingModule implements AgentModule {
    readonly name = "scheduling";
    readonly migrations = schedulingMigrations;

    readonly #store: SchedulingStore = createSqliteSchedulingStorage();
    readonly #suspensions = new SchedulingSuspensions();

    /** Subscribers taken after construction, inside and after the committing transaction. */
    readonly #transactionalListeners = new Set<SchedulingEventListener>();
    readonly #postCommitListeners = new Set<SchedulingEventListener>();

    /** Live alarms for pending messages, and the deliveries currently in flight. */
    readonly #alarms = new Map<string, SchedulingAlarm>();
    readonly #delivering = new Set<string>();

    #agents: AgentSystemRef | undefined;
    #deliveryCtx: Context | undefined;

    /**
     * Take the agent collection, then re-arm everything the last process left pending.
     *
     * Delivery outlives the call that scheduled it, so it runs on a context of the module's own
     * derived here rather than on a tool call's, which is gone long before the message is due.
     */
    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        // Detaching drops the database along with the caller's lifetime, and delivery needs it
        // for the rest of the process's life, so it is carried onto the module's own context.
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Scheduling was started without an agent database.");
        }
        this.#deliveryCtx = withAgentDatabase(detach(ctx).named("scheduling"), database);
        await this.#recoverPending(ctx);
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            this.#assertAgentId(scope.agent.id, "tool agent");
            const tools: AnyAgentTool[] = [
                waitTool(this, scope.agent.id),
                waitUntilTool(this, scope.agent.id),
            ];
            // A subagent answers whoever created it and then stops; a message it scheduled would
            // arrive for an agent that is no longer anyone's correspondent.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) === null) {
                tools.push(
                    scheduleMessageTool(this, scope.agent.id),
                    listScheduledMessagesTool(this, scope.agent.id),
                    cancelScheduledMessageTool(this, scope.agent.id),
                );
            }
            return tools;
        },
        // A message this agent has taken into its conversation is the plainest possible proof that
        // it is no longer idle, so any wait it is still holding ends here.
        messageAccepted: (_ctx: Context, scope: AgentModuleScope): void => {
            this.#suspensions.interrupt(scope.agent.id);
        },
    };

    /**
     * Watch scheduling inside the transaction that commits the change.
     *
     * A transactional subscriber runs before the commit, so throwing from one rejects the mutation
     * that produced the event. Returns the function that ends the subscription.
     */
    onEventTransactional(listener: SchedulingEventListener): SchedulingUnsubscribe {
        return this.#subscribe(this.#transactionalListeners, listener);
    }

    /**
     * Watch scheduling after the outermost transaction has committed.
     *
     * A post-commit subscriber cannot undo anything, so a failure in one is logged and the
     * remaining subscribers still see the event. Returns the function that ends the subscription.
     */
    onEvent(listener: SchedulingEventListener): SchedulingUnsubscribe {
        return this.#subscribe(this.#postCommitListeners, listener);
    }

    /** Pause an agent for a bounded duration. */
    async wait(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitInput,
    ): Promise<SchedulingWaitResult> {
        this.#assertInput(schedulingWaitInputSchema, input, "wait input");
        return await this.#wait(ctx, agentId, input.id, "wait", (startedAt) =>
            this.#dueFromDuration(startedAt, durationMilliseconds(input.duration)),
        );
    }

    /** Pause an agent until a bounded date, resolving immediately for a date already past. */
    async waitUntil(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitUntilInput,
    ): Promise<SchedulingWaitResult> {
        this.#assertInput(schedulingWaitUntilInputSchema, input, "wait until input");
        return await this.#wait(ctx, agentId, input.id, "wait_until", (startedAt) =>
            this.#dueFromInstant(startedAt, instantMilliseconds(input.at)),
        );
    }

    /**
     * End every wait this agent is holding, because something has arrived for it.
     *
     * Happy Agent calls this when a person submits or steers a message into a session: a queued message
     * does not reach the agent's conversation until its current turn ends, and its current turn is
     * exactly what the wait is holding open.
     */
    interruptWaits(_ctx: Context, agentId: string): void {
        this.#assertAgentId(agentId, "acting agent");
        this.#suspensions.interrupt(agentId);
    }

    /** Promise a message to any agent whose ID the sender knows, including itself. */
    async schedule(
        ctx: Context,
        agentId: string,
        input: SchedulingScheduleInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingScheduleInputSchema, input, "schedule message");
        if (input.message.length > MAX_SCHEDULING_MESSAGE_LENGTH) {
            throw new Error(
                `A scheduled message cannot exceed ${MAX_SCHEDULING_MESSAGE_LENGTH} characters.`,
            );
        }
        const targetAgentId = input.targetAgentId ?? agentId;
        this.#assertAgentId(targetAgentId, "target agent");
        const schedule = await ctx.inTx(async (txCtx) => {
            const id = input.id ?? this.#newId();
            const existing = await this.#readSchedule(txCtx, id);
            if (existing !== undefined) {
                // The same durable tool call, running a second time after a restart.
                if (
                    existing.senderAgentId !== agentId ||
                    existing.targetAgentId !== targetAgentId ||
                    existing.message !== input.message
                ) {
                    throw new Error(`Scheduled message "${id}" already exists.`);
                }
                return existing;
            }
            const now = this.#now();
            const dueAt =
                "in" in input
                    ? this.#dueFromDuration(
                          now,
                          durationMilliseconds(input.in),
                          MAX_SCHEDULING_HORIZON,
                      )
                    : this.#dueFromInstant(
                          now,
                          instantMilliseconds(input.at),
                          MAX_SCHEDULING_HORIZON,
                      );
            const created: SchedulingScheduledMessage = {
                id,
                senderAgentId: agentId,
                targetAgentId,
                message: input.message,
                dueAt,
                status: "pending",
                createdAt: now,
                updatedAt: now,
            };
            await this.#writeSchedule(txCtx, created);
            await this.#announce(
                txCtx,
                this.#event({
                    type: "message_scheduled",
                    agentId,
                    schedule: created,
                }),
            );
            afterCommit(txCtx, () => {
                this.#arm(created);
            });
            return created;
        });
        return structuredClone(schedule);
    }

    /** Withdraw a message the sender promised, if it has not already left. */
    async cancelSchedule(
        ctx: Context,
        agentId: string,
        input: SchedulingCancelInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingCancelInputSchema, input, "schedule cancellation");
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredSchedule(txCtx, input.scheduleId);
            if (before.senderAgentId !== agentId) {
                throw new Error(`Scheduled message "${input.scheduleId}" does not exist.`);
            }
            if (before.status !== "pending") return structuredClone(before);
            const cancelled: SchedulingScheduledMessage = {
                ...before,
                status: "cancelled",
                updatedAt: this.#now(),
            };
            await this.#writeSchedule(txCtx, cancelled);
            await this.#announce(
                txCtx,
                this.#event({
                    type: "scheduled_message_cancelled",
                    agentId,
                    schedule: cancelled,
                }),
            );
            afterCommit(txCtx, () => {
                this.#disarm(cancelled.id);
            });
            return structuredClone(cancelled);
        });
    }

    /** One bounded page of the messages this agent promised, in due order. */
    async listSchedulePage(
        ctx: Context,
        agentId: string,
        query: SchedulingSchedulePageQuery = {},
    ): Promise<SchedulingSchedulePage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingSchedulePageQuerySchema, query, "schedule page query");
        const limit = Math.min(query.limit ?? SCHEDULING_PAGE_SIZE, SCHEDULING_PAGE_SIZE);
        return await ctx.inTx(async (txCtx) => {
            const page = await this.#store.listSchedules(txCtx, {
                ...query,
                limit,
                senderAgentId: agentId,
            });
            assertSchedulingPage(page, limit);
            for (const schedule of page.schedules) {
                assertSchedulingScheduledMessage(schedule);
                if (schedule.senderAgentId !== agentId) {
                    throw new Error("Scheduling returned a message belonging to another agent.");
                }
            }
            return structuredClone(page);
        });
    }

    /** One scheduled message, readable by the agent that sent it and the agent it is for. */
    async getSchedule(
        ctx: Context,
        agentId: string,
        scheduleId: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertId(scheduleId, "schedule");
        return await ctx.inTx(async (txCtx) => {
            const schedule = await this.#readSchedule(txCtx, scheduleId);
            if (schedule === undefined) return undefined;
            if (schedule.senderAgentId !== agentId && schedule.targetAgentId !== agentId) {
                return undefined;
            }
            return structuredClone(schedule);
        });
    }

    /** Drop every live alarm and wake every suspended wait, for a process that is shutting down. */
    stop(): void {
        for (const id of [...this.#alarms.keys()]) this.#disarm(id);
        this.#suspensions.interruptAll();
    }

    formatWaitForModel(result: SchedulingWaitResult): string {
        assertSchedulingWaitResult(result);
        return waitText(result);
    }

    formatScheduleForModel(schedule: SchedulingScheduledMessage): string {
        assertSchedulingScheduledMessage(schedule);
        return scheduleText(schedule);
    }

    formatCancellationForModel(schedule: SchedulingScheduledMessage): string {
        assertSchedulingScheduledMessage(schedule);
        return cancellationText(schedule);
    }

    formatSchedulePageForModel(page: SchedulingSchedulePage): string {
        assertSchedulingPage(page, MAX_SCHEDULING_PAGE_SIZE);
        return schedulePageText(page, SCHEDULING_OUTPUT_CHARACTERS).text;
    }

    /**
     * Claim the durable wait, hold the tool call outside every transaction, then settle it.
     *
     * The two transactions are deliberately short and the suspension sits between them: a wait may
     * last a day, and no database write lock survives one.
     */
    async #wait(
        ctx: Context,
        agentId: string,
        requestedId: string | undefined,
        kind: "wait" | "wait_until",
        dueAtFrom: (startedAt: number) => number,
    ): Promise<SchedulingWaitResult> {
        this.#assertAgentId(agentId, "acting agent");
        const id = requestedId ?? this.#newId();
        this.#assertId(id, "wait");
        const claimed = await ctx.inTx(async (txCtx) => {
            const existing = await this.#readWait(txCtx, agentId, id);
            if (existing !== undefined) {
                if (existing.kind !== kind) {
                    throw new Error("That wait identity belongs to another kind of wait.");
                }
                return structuredClone(existing);
            }
            const startedAt = this.#now();
            const claimed: SchedulingWaitingRecord = {
                id,
                agentId,
                kind,
                status: "waiting",
                dueAt: dueAtFrom(startedAt),
                createdAt: startedAt,
                updatedAt: startedAt,
                startedAt,
            };
            await this.#writeWait(txCtx, claimed);
            await this.#announce(
                txCtx,
                this.#event({ type: "wait_started", agentId, wait: claimed }),
            );
            return claimed;
        });
        if (claimed.status !== "waiting") return waitResult(claimed);
        const outcome = await this.#suspensions.suspend(agentId, claimed.dueAt, ctx.lifetime);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredWait(txCtx, agentId, id);
            if (before.status !== "waiting") return waitResult(before);
            const finishedAt =
                outcome === "elapsed"
                    ? Math.max(this.#now(), before.dueAt)
                    : Math.max(this.#now(), before.startedAt);
            const settled: SchedulingWaitRecord = {
                ...before,
                status: outcome,
                updatedAt: finishedAt,
                finishedAt,
                elapsedMs: finishedAt - before.startedAt,
            };
            await this.#writeWait(txCtx, settled);
            const result = waitResult(settled);
            await this.#announce(
                txCtx,
                this.#event({
                    type: "wait_finished",
                    agentId,
                    wait: settled,
                    result,
                }),
            );
            return result;
        });
    }

    /** Re-arm every message the previous process left pending, oldest due time first. */
    async #recoverPending(ctx: Context): Promise<void> {
        let afterDueAt: number | undefined;
        for (;;) {
            const pending = await ctx.inTx(
                async (txCtx) =>
                    await this.#store.listPendingSchedules(txCtx, {
                        limit: MAX_SCHEDULING_RECOVERY_BATCH,
                        ...(afterDueAt === undefined ? {} : { afterDueAt }),
                    }),
            );
            for (const schedule of pending) {
                assertSchedulingScheduledMessage(schedule);
                this.#arm(schedule);
            }
            const last = pending.at(-1);
            if (last === undefined || pending.length < MAX_SCHEDULING_RECOVERY_BATCH) return;
            // Paging by due time skips the remainder of a shared millisecond rather than looping
            // on it forever; those few are re-armed by the next start.
            afterDueAt = last.dueAt;
        }
    }

    /** Hold one alarm per pending message, replacing any alarm already held for it. */
    #arm(schedule: SchedulingScheduledMessage): void {
        this.#disarm(schedule.id);
        if (schedule.status !== "pending") return;
        this.#alarms.set(
            schedule.id,
            new SchedulingAlarm(schedule.dueAt, () => {
                this.#alarms.delete(schedule.id);
                void this.#deliver(schedule.id);
            }),
        );
    }

    #disarm(scheduleId: string): void {
        this.#alarms.get(scheduleId)?.cancel();
        this.#alarms.delete(scheduleId);
    }

    /**
     * Put a due message in its recipient's inbox, then record what became of it.
     *
     * The delivery itself happens outside every transaction, because a database cannot roll a
     * message back out of an agent's conversation. It is safe to repeat: Agent Base accepts a
     * given message ID once, so a redelivery after a crash is recognised rather than duplicated.
     */
    async #deliver(scheduleId: string): Promise<void> {
        if (this.#delivering.has(scheduleId)) return;
        this.#delivering.add(scheduleId);
        const ctx = this.#requireDeliveryContext();
        try {
            const due = await ctx.inTx(
                async (txCtx) => await this.#readSchedule(txCtx, scheduleId),
            );
            if (due === undefined || due.status !== "pending") return;
            if (this.#now() < due.dueAt) {
                this.#arm(due);
                return;
            }
            const failure = await this.#send(ctx, due);
            await ctx.inTx(async (txCtx) => {
                const before = await this.#readSchedule(txCtx, scheduleId);
                if (before === undefined || before.status !== "pending") return;
                const at = Math.max(this.#now(), before.dueAt);
                const settled: SchedulingScheduledMessage =
                    failure === undefined
                        ? { ...before, status: "delivered", updatedAt: at, deliveredAt: at }
                        : { ...before, status: "undelivered", updatedAt: at, failure };
                await this.#writeSchedule(txCtx, settled);
                await this.#announce(
                    txCtx,
                    this.#event({
                        type: "scheduled_message_delivery_outcome",
                        agentId: settled.senderAgentId,
                        schedule: settled,
                    }),
                );
            });
            // The message is in the recipient's conversation now, so a wait it is holding is over.
            if (failure === undefined) this.#suspensions.interrupt(due.targetAgentId);
        } catch (error: unknown) {
            ctx.log.error(
                { error, scheduleId },
                "A scheduled message could not be settled after delivery.",
            );
        } finally {
            this.#delivering.delete(scheduleId);
        }
    }

    /** Hand the message over, and return why it did not arrive when it did not. */
    async #send(ctx: Context, schedule: SchedulingScheduledMessage): Promise<string | undefined> {
        const introduction =
            schedule.senderAgentId === schedule.targetAgentId
                ? "A message you scheduled for now:"
                : `A message agent ${schedule.senderAgentId} scheduled for now:`;
        try {
            await this.#requireAgents().send(
                ctx,
                schedule.targetAgentId,
                {
                    role: "user",
                    content: [{ type: "text", text: `${introduction}\n\n${schedule.message}` }],
                },
                {
                    id: schedule.id,
                    metadata: {
                        scheduling: {
                            scheduleId: schedule.id,
                            senderAgentId: schedule.senderAgentId,
                            targetAgentId: schedule.targetAgentId,
                        },
                        ...senderAgentIdMetadata(schedule.senderAgentId),
                    },
                },
            );
            return undefined;
        } catch (error: unknown) {
            return boundedFailure(error);
        }
    }

    async #readWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const wait = await this.#store.readWait(ctx, agentId, id);
        if (wait === undefined) return undefined;
        assertSchedulingWaitRecord(wait);
        if (wait.id !== id || wait.agentId !== agentId) {
            throw new Error("Scheduling store returned a different durable wait identity.");
        }
        return wait;
    }

    async #readRequiredWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord> {
        const wait = await this.#readWait(ctx, agentId, id);
        if (wait === undefined) throw new Error("That durable wait no longer exists.");
        return wait;
    }

    async #writeWait(ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        assertSchedulingWaitRecord(wait);
        await this.#store.writeWait(ctx, structuredClone(wait));
    }

    async #readSchedule(ctx: Context, id: string): Promise<SchedulingScheduledMessage | undefined> {
        const schedule = await this.#store.readSchedule(ctx, id);
        if (schedule === undefined) return undefined;
        assertSchedulingScheduledMessage(schedule);
        if (schedule.id !== id) {
            throw new Error("Scheduling store returned a different scheduled message identity.");
        }
        return schedule;
    }

    async #readRequiredSchedule(ctx: Context, id: string): Promise<SchedulingScheduledMessage> {
        const schedule = await this.#readSchedule(ctx, id);
        if (schedule === undefined) throw new Error(`Scheduled message "${id}" does not exist.`);
        return schedule;
    }

    async #writeSchedule(ctx: Context, schedule: SchedulingScheduledMessage): Promise<void> {
        assertSchedulingScheduledMessage(schedule);
        await this.#store.writeSchedule(ctx, structuredClone(schedule));
    }

    #event(payload: SchedulingEventPayload): SchedulingEvent {
        const event = { ...payload, eventId: randomSchedulingId(), at: this.#now() };
        if (!Value.Check(schedulingEventSchema, event)) {
            throw new Error("Scheduling module created an invalid event.");
        }
        return deepFreeze(structuredClone(event as SchedulingEvent));
    }

    #subscribe(
        listeners: Set<SchedulingEventListener>,
        listener: SchedulingEventListener,
    ): SchedulingUnsubscribe {
        if (!Value.Check(schedulingEventListenerSchema, listener)) {
            throw new Error("A scheduling subscriber must be a function.");
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async #announce(ctx: Context, event: SchedulingEvent): Promise<void> {
        // A snapshot, so subscribing or unsubscribing from inside a subscriber cannot change who
        // this event goes to.
        for (const listener of [...this.#transactionalListeners]) await listener(ctx, event);
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SchedulingEvent): Promise<void> {
        for (const listener of [...this.#postCommitListeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                // Nothing here can undo a scheduling change the database has already committed,
                // and one failing subscriber must not hide the event from the rest.
                ctx.log.error(
                    { error, eventId: event.eventId, type: event.type },
                    "A scheduling subscriber failed after the change was committed.",
                );
            }
        }
    }

    #dueFromDuration(now: number, amount: number, horizon = MAX_SCHEDULING_WAIT_DURATION): number {
        if (amount > horizon) {
            throw new Error(`That is longer than the ${humanDuration(horizon)} limit.`);
        }
        return this.#dueAt(now + amount);
    }

    #dueFromInstant(
        now: number,
        requested: number,
        horizon = MAX_SCHEDULING_WAIT_DURATION,
    ): number {
        const dueAt = Math.max(now, requested);
        if (dueAt - now > horizon) {
            throw new Error(`That is further away than the ${humanDuration(horizon)} limit.`);
        }
        return this.#dueAt(dueAt);
    }

    #dueAt(value: number): number {
        if (!Value.Check(schedulingTimestampSchema, value)) {
            throw new Error("That resolves to a time scheduling cannot represent.");
        }
        return value;
    }

    #now(): number {
        const now = Date.now();
        if (!Value.Check(schedulingTimestampSchema, now)) {
            throw new Error("The clock returned a time scheduling cannot represent.");
        }
        return now;
    }

    #newId(): string {
        return randomSchedulingId();
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) {
            throw new Error("Scheduling has not been started by an agent system yet.");
        }
        return this.#agents;
    }

    #requireDeliveryContext(): Context {
        if (this.#deliveryCtx === undefined) {
            throw new Error("Scheduling has not been started by an agent system yet.");
        }
        return this.#deliveryCtx;
    }

    #assertAgentId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingAgentIdSchema, value)) {
            throw new Error(`The ${label} ID is not a valid agent identity.`);
        }
    }

    #assertId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingMessageIdSchema, value)) {
            throw new Error(`The ${label} ID is not a valid scheduling identity.`);
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`The ${label} is invalid.`);
    }
}

type SchedulingEventPayload =
    | {
          readonly type: "wait_started";
          readonly agentId: string;
          readonly wait: SchedulingWaitRecord;
      }
    | {
          readonly type: "wait_finished";
          readonly agentId: string;
          readonly wait: SchedulingWaitRecord;
          readonly result: SchedulingWaitResult;
      }
    | {
          readonly type:
              | "message_scheduled"
              | "scheduled_message_cancelled"
              | "scheduled_message_delivery_outcome";
          readonly agentId: string;
          readonly schedule: SchedulingScheduledMessage;
      };

function waitResult(wait: SchedulingWaitRecord): SchedulingWaitResult {
    if (wait.status === "waiting") throw new Error("A waiting record has no final result.");
    const result: SchedulingWaitResult = {
        waitId: wait.id,
        agentId: wait.agentId,
        outcome: wait.status,
        kind: wait.kind,
        dueAt: wait.dueAt,
        startedAt: wait.startedAt,
        endedAt: wait.finishedAt,
        elapsedMs: wait.elapsedMs,
    };
    assertSchedulingWaitResult(result);
    return result;
}

/** A cuid2-shaped identity, which is what Agent Base accepts as a message ID. */
function randomSchedulingId(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(23));
    let id = "s";
    for (const byte of bytes) id += alphabet[byte % alphabet.length];
    return id;
}

function boundedFailure(error: unknown): string {
    let message: string;
    try {
        message =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : String(error);
    } catch {
        message = "";
    }
    return message.slice(0, MAX_SCHEDULING_FAILURE_LENGTH) || "The delivery failed.";
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}
