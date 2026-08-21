import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBaseLoop,
    AgentBasePermissionModeChange,
    AgentBaseSettlement,
    AgentBaseTurn,
    AgentDatabase,
    AgentMetadataChange,
    AgentModule,
    AgentModuleAgentLifecycle,
    AgentModuleHooks,
    AgentModuleScope,
    AgentModuleSystemScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionEvent,
    SessionOutputBlock,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    deleteActiveRun,
    eventsMigrations,
    insertEvent,
    loadActiveRun,
    loadActiveRuns,
    loadEventState,
    loadLatestAgentEvent,
    loadPreviousEventCursor,
    saveActiveRun,
    saveOriginCursor,
    trimEvents,
    validateAppendEvent,
} from "./EventsDatabase.js";
import { createUuidV7Factory } from "./createUuidV7.js";
import {
    appendEventInputSchema,
    eventIdSchema,
    eventSchema,
    type AgentEvent,
    type AppendEventInput,
    type EventListener,
    type EventReplay,
    type EventsModuleListener,
    latestAgentEventSchema,
    type LatestAgentEvent,
    eventAgentIdSchema,
} from "./types.js";

const unknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof unknownRecordSchema>;

const activeRunSchema = Type.Object(
    {
        activeIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        activeKind: Type.Union([
            Type.Literal("reasoning"),
            Type.Literal("text"),
            Type.Literal("tool"),
            Type.Null(),
        ]),
        argumentBuffers: Type.Record(Type.String(), Type.String()),
        blocks: Type.Array(Type.Unknown()),
        acceptedMessageIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
            maxItems: 512,
        }),
        callIndexes: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
        /**
         * What the provider said when it ended the run badly. It is kept on the run so the
         * settlement event can describe the failure, rather than leaving a client to reconstruct
         * it from the raw provider event it may not understand.
         */
        errorMessage: Type.Optional(Type.String({ maxLength: 8_192 })),
        runId: Type.String({ minLength: 1, maxLength: 256 }),
        hasProviderEvent: Type.Boolean(),
        stopReason: Type.Union([
            Type.Literal("aborted"),
            Type.Literal("error"),
            Type.Literal("length"),
            Type.Literal("stop"),
        ]),
        text: Type.String(),
    },
    { additionalProperties: false },
);
type ActiveRun = Static<typeof activeRunSchema>;

/**
 * How many events the live window keeps before its oldest durable prefix is dropped.
 *
 * The journal is a replay buffer for clients catching up, not the record of everything that ever
 * happened, so the bound is a property of the feature rather than something a caller tunes.
 */
export const EVENTS_CAPACITY = 10_000;

/**
 * The daemon's durable, bounded event journal.
 *
 * Provider `SessionEvent` values are stored verbatim. A separate `rigEvent` projection is attached
 * when Rig's current transcript reducer needs its indexed message shape; it is an adapter, never
 * a replacement for the provider event.
 */
export class EventsModule implements AgentModule<AnyAgentTool> {
    readonly name = "events";
    readonly migrations = eventsMigrations;
    readonly #entries: AgentEvent[] = [];
    readonly #listeners = new Set<EventListener>();
    /**
     * The loop each agent has opened and not yet had journaled, because the run it belongs to had
     * no identity at the time. It is live-process bookkeeping rather than a record of anything:
     * a loop interrupted by a restart is announced again by the process that resumes it.
     */
    readonly #openingLoops = new Map<string, AgentBaseLoop>();
    readonly #runs = new Map<string, ActiveRun>();
    #createId: () => string = createUuidV7Factory(Date.now);
    #moduleListener: EventsModuleListener | undefined;
    #originCursor: string = this.#createId();
    #occurredAt = 0;

    /**
     * Registers the one listener that sees an event as it is recorded.
     *
     * `subscribe` observes an event once it is durably part of history; this is the seam for
     * something that must act inside the very transaction that records it, so its own writes commit
     * with the event or not at all. There is exactly one, because two such listeners would share a
     * transaction neither of them owns, and either could roll the other's work back.
     */
    observe(listener: EventsModuleListener): void {
        if (this.#moduleListener !== undefined) {
            throw new Error("The event journal already has a listener recording alongside it.");
        }
        this.#moduleListener = listener;
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const loaded = await ctx.inTx(
            async (txCtx) => await loadEventState(txCtx.db, this.capacity()),
        );
        this.#entries.push(...loaded.events.map(freezeEvent));
        this.#occurredAt = this.#entries.at(-1)?.occurredAt ?? 0;
        this.#originCursor = loaded.originCursor ?? this.#originCursor;
        const highWater = this.#entries.at(-1)?.id ?? this.#originCursor;
        this.#createId = createUuidV7Factory(Date.now, highWater);
        const runs = await loadActiveRuns(ctx.db, parseActiveRun);
        for (const [agentId, run] of runs) this.#runs.set(agentId, run);
        return this.#hooks;
    };

    cursor(): string {
        return this.#entries.at(-1)?.id ?? this.#originCursor;
    }

    originCursor(): string {
        return this.#originCursor;
    }

    latestCursor(agentId: string): string | undefined {
        return this.#entries.findLast((event) => event.agentId === agentId)?.id;
    }

    /** The newest durable event identity and time for one agent, read as one consistent fact. */
    async latestAgentEvent(ctx: Context, agentId: string): Promise<LatestAgentEvent | undefined> {
        if (!Value.Check(eventAgentIdSchema, agentId)) {
            throw new Error("The event journal received an invalid agent event lookup.");
        }
        const latest = await loadLatestAgentEvent(ctx.db, agentId);
        if (latest !== undefined && !Value.Check(latestAgentEventSchema, latest)) {
            throw new Error("The event journal found invalid latest agent event metadata.");
        }
        return latest;
    }

    /**
     * How many events the live window keeps. Every bound inside the journal reads it from here, so
     * a subclass that answers differently really does get a smaller window — which is how a test
     * exercises retention without recording ten thousand events.
     */
    capacity(): number {
        return EVENTS_CAPACITY;
    }

    /**
     * The run this agent is working on, or undefined when it is not working on one.
     *
     * This is the same identity the journal writes and the client was handed when its message was
     * accepted, which is what lets a caller name the run it means before acting on it.
     */
    activeRunId(agentId: string): string | undefined {
        return this.#runs.get(agentId)?.runId;
    }

    /** The active run identity visible inside the caller's current transaction. */
    async activeRunIdInTransaction(ctx: Context, agentId: string): Promise<string | undefined> {
        if (!Value.Check(eventAgentIdSchema, agentId)) {
            throw new Error("The event journal received an invalid active run lookup.");
        }
        return (await loadActiveRun(ctx.db, agentId, parseActiveRun))?.runId;
    }

    /**
     * Resolve and persist the exact run identity for one accepted message in the caller's
     * transaction.
     *
     * Multiple messages consumed together share the first message's run. Once provider work has
     * begun, the next accepted message opens the next run; steering is therefore a boundary while
     * messages merely queued during a run remain pending until that run has produced its answer.
     * Repeating this for the same accepted ID is harmless, which lets another module ask before
     * the Events hook records its own envelope.
     */
    async runIdForAccepted(
        ctx: Context,
        agentId: string,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<string> {
        if (
            !Value.Check(eventAgentIdSchema, agentId) ||
            !Value.Check(eventAgentIdSchema, accepted.id)
        ) {
            throw new Error("The event journal received an invalid accepted message identity.");
        }
        const previous = await loadActiveRun(ctx.db, agentId, parseActiveRun);
        let run: ActiveRun;
        if (previous?.acceptedMessageIds.includes(accepted.id) === true) {
            run = previous;
        } else if (previous === undefined || previous.hasProviderEvent) {
            run = {
                ...emptyRun(accepted.id),
                acceptedMessageIds: [accepted.id],
            };
        } else {
            run = {
                ...previous,
                acceptedMessageIds: [...previous.acceptedMessageIds, accepted.id],
            };
        }
        await saveActiveRun(ctx.db, agentId, run);
        afterCommit(ctx, () => {
            this.#runs.set(agentId, run);
        });
        return run.runId;
    }

    /** The exact prior resource-event cursor, including inside the current event transaction. */
    async previousCursor(
        ctx: Context,
        agentId: string,
        beforeId?: string,
    ): Promise<string | undefined> {
        if (
            !Value.Check(eventAgentIdSchema, agentId) ||
            (beforeId !== undefined && !Value.Check(eventIdSchema, beforeId))
        ) {
            throw new Error("The event journal received an invalid cursor lookup.");
        }
        return await loadPreviousEventCursor(ctx.db, agentId, beforeId);
    }

    async record(ctx: Context, input: AppendEventInput): Promise<AgentEvent> {
        return await ctx.inTx(async (txCtx) => {
            return await this.recordInDatabase(txCtx, txCtx.db, input);
        });
    }

    replay(after?: string, limit = this.capacity()): EventReplay | undefined {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.capacity()) {
            throw new Error(`The event replay limit must be between 1 and ${this.capacity()}.`);
        }
        const latestCursor = this.cursor();
        if (after === undefined) return { cursor: latestCursor, events: [], latestCursor };
        if (after === this.#originCursor) {
            const events = this.#entries.slice(0, limit);
            return { cursor: events.at(-1)?.id ?? after, events, latestCursor };
        }
        const index = this.#entries.findIndex((event) => event.id === after);
        if (index < 0) return undefined;
        const events = this.#entries.slice(index + 1, index + 1 + limit);
        return { cursor: events.at(-1)?.id ?? after, events, latestCursor };
    }

    async trim(
        ctx: Context,
        through: string,
    ): Promise<{ readonly through: string; readonly trimmed: number } | undefined> {
        if (!Value.Check(eventIdSchema, through)) return undefined;
        if (through === this.#originCursor) return { through, trimmed: 0 };
        return await ctx.inTx(async (txCtx) => {
            const trimmed = await trimEvents(txCtx.db, through);
            if (trimmed === undefined) return undefined;
            afterCommit(txCtx, () => {
                const index = this.#entries.findIndex((event) => event.id === through);
                if (index >= 0) this.#entries.splice(0, index + 1);
                this.#originCursor = through;
            });
            return { through, trimmed };
        });
    }

    subscribe(listener: EventListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    messageCursor(agentId: string, messageId: string): string | undefined {
        return this.#entries.findLast(
            (event) =>
                event.agentId === agentId &&
                event.type === "message.accepted" &&
                recordValue(event.payload)?.id === messageId,
        )?.id;
    }

    readonly #hooks: AgentModuleHooks = {
        agentCreatedTransact: async (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: agent.id,
                payload: agent,
                type: "agent.created",
            });
        },

        agentRestoredTransact: async (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: agent.id,
                payload: agent,
                type: "agent.restored",
            });
            const run = this.#runs.get(agent.id);
            if (run !== undefined) {
                const projected = projectProviderEvent(run, { type: "block_reset" }, Date.now());
                await saveActiveRun(ctx.db, agent.id, projected.run);
                await this.recordInDatabase(ctx, ctx.db, {
                    agentId: agent.id,
                    payload: {
                        event: { type: "block_reset" },
                        recovered: true,
                        rigEvent: projected.rigEvent,
                        runId: run.runId,
                    },
                    type: "provider.event",
                });
            }
        },

        agentArchivedTransact: async (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: agent.id,
                payload: agent,
                type: "agent.archived",
            });
        },

        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            // The run this message steers may have been accepted earlier in this very transaction,
            // where the in-memory map has not been updated yet, so the transaction's own row is the
            // authority on what is running.
            const runId = await this.runIdForAccepted(ctx, scope.agent.id, accepted);
            await this.openLoop(ctx, scope.agent.id, runId);
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                // Message content belongs to History and may carry tens of MiB of inline media.
                // The journal records only the ordered acceptance fact needed to project runs.
                payload: { id: accepted.id, kind: accepted.kind, runId },
                type: "message.accepted",
            });
        },

        permissionModeChangedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            change: AgentBasePermissionModeChange,
        ): Promise<void> => {
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: change,
                type: "agent.permission-changed",
            });
        },

        metadataChangedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            change: AgentMetadataChange,
        ): Promise<void> => {
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: change,
                type: "agent.metadata-changed",
            });
        },

        beforeAgentLoopTransact: (
            _ctx: Context,
            scope: AgentModuleScope,
            loop: AgentBaseLoop,
        ): void => {
            // A loop opens before its first message is accepted, so at this point there is no run
            // to name and inventing one here would name a run that never settles. The start is
            // held until the loop first says which run it is answering, which is what lets a
            // client pair it with the settlement of that same run.
            this.#openingLoops.set(scope.agent.id, loop);
        },

        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            await ctx.inTx(async (txCtx) => {
                const current = this.#runs.get(scope.agent.id) ?? emptyRun(this.#createId());
                const projected = projectProviderEvent(
                    { ...current, hasProviderEvent: true },
                    event,
                    Date.now(),
                );
                await saveActiveRun(txCtx.db, scope.agent.id, projected.run);
                afterCommit(txCtx, () => {
                    this.#runs.set(scope.agent.id, projected.run);
                });
                await this.openLoop(txCtx, scope.agent.id, projected.run.runId);
                await this.recordInDatabase(txCtx, txCtx.db, {
                    agentId: scope.agent.id,
                    payload: {
                        event,
                        rigEvent: projected.rigEvent,
                        runId: projected.run.runId,
                        provider: scope.agent.provider,
                        ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                        ...(event.type === "text_end" ? { text: projected.run.text } : {}),
                    },
                    type: "provider.event",
                });
            });
        },

        beforeToolCallTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            call: SessionToolCallBlock,
        ): Promise<void> => {
            const runId = this.#runs.get(scope.agent.id)?.runId ?? call.callId;
            await this.openLoop(ctx, scope.agent.id, runId);
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: {
                    rigEvent: {
                        toolCall: presentedToolCall(call),
                        type: "tool_execution_start",
                    },
                    runId,
                    provider: scope.agent.provider,
                    ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                },
                type: "tool.started",
            });
        },

        afterToolCallTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            result: SessionToolResultMessage,
        ): Promise<void> => {
            // The tool result is recorded in the same transaction as its conversation entry. The
            // durable row, rather than the post-commit cache, is therefore authoritative here.
            const run = await loadActiveRun(ctx.db, scope.agent.id, parseActiveRun);
            const toolName = toolNameForCall(run, result.callId);
            const completion = toolExecutionEnd(
                result.callId,
                toolName,
                result.content,
                result.isError,
            );
            const next =
                run === undefined
                    ? undefined
                    : {
                          ...run,
                          blocks: [...run.blocks, completion["result"]],
                      };
            if (next !== undefined) {
                await saveActiveRun(ctx.db, scope.agent.id, next);
                afterCommit(ctx, () => {
                    this.#runs.set(scope.agent.id, next);
                });
                await this.openLoop(ctx, scope.agent.id, next.runId);
            }
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: {
                    ...result,
                    provider: scope.agent.provider,
                    ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                    // The model's context keeps the real bytes; the journal row would otherwise
                    // carry the same media blob in the result, projection, and partial at once
                    // and overrun the durable payload bound.
                    content: boundedOutputBlocks(result.content),
                    rigEvent:
                        next === undefined
                            ? completion
                            : {
                                  ...completion,
                                  // Public message consumers must see the completed tool before
                                  // later inference or settlement events can advance the run.
                                  partial: partialMessage(next, Date.now()),
                              },
                    runId: next?.runId,
                },
                type: "tool.completed",
            });
        },

        afterInferenceTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => {
            const run = this.#runs.get(scope.agent.id);
            const runId = run?.runId ?? inference.loopId;
            await this.openLoop(ctx, scope.agent.id, runId);
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: {
                    ...inference,
                    blocks: run?.blocks ?? [],
                    runId,
                    text: run?.text ?? "",
                },
                type: "inference.completed",
            });
        },

        afterTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): Promise<void> => {
            const run = this.#runs.get(scope.agent.id);
            const next =
                run !== undefined && turn.aborted
                    ? { ...run, stopReason: "aborted" as const }
                    : run;
            if (next !== undefined) {
                await saveActiveRun(ctx.db, scope.agent.id, next);
                afterCommit(ctx, () => {
                    this.#runs.set(scope.agent.id, next);
                });
            }
            const runId = next?.runId ?? turn.loopId;
            await this.openLoop(ctx, scope.agent.id, runId);
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: { ...turn, runId },
                type: "turn.completed",
            });
        },

        afterAgentSettledTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            settlement: AgentBaseSettlement,
        ): Promise<void> => {
            const run = this.#runs.get(scope.agent.id);
            const runId = run?.runId ?? settlement.loopId;
            // A loop that never named a run — the one an agent opens on startup to look for work
            // it was left owing — still opens here, so no settlement is ever journaled without
            // the start it answers.
            await this.openLoop(ctx, scope.agent.id, runId);
            await this.recordInDatabase(ctx, ctx.db, {
                agentId: scope.agent.id,
                payload: {
                    ...settlement,
                    ...(run?.errorMessage === undefined ? {} : { errorMessage: run.errorMessage }),
                    runId,
                    stopReason: run?.stopReason ?? "stop",
                },
                type: "loop.settled",
            });
            await deleteActiveRun(ctx.db, scope.agent.id);
            afterCommit(ctx, () => {
                this.#runs.delete(scope.agent.id);
            });
        },
    };

    /**
     * Journal the start of the loop an agent has open, under the identity of the run it turned
     * out to be answering. Every event a loop records names its run, and the first of them is
     * what finally says which run that is, so the start is written immediately before it — once
     * per loop, and always ahead of everything the run goes on to record.
     */
    private async openLoop(ctx: Context, agentId: string, runId: string): Promise<void> {
        const loop = this.#openingLoops.get(agentId);
        if (loop === undefined) return;
        // Given up before the append, so a second event naming the same run in the same
        // transaction cannot open one loop twice.
        this.#openingLoops.delete(agentId);
        await this.recordInDatabase(ctx, ctx.db, {
            agentId,
            payload: { ...loop, runId },
            type: "loop.started",
        });
    }

    private async recordInDatabase(
        ctx: Context,
        database: AgentDatabase,
        input: AppendEventInput,
    ): Promise<AgentEvent> {
        validateAppendEvent(input);
        const event = freezeEvent({
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            id: this.#createId(),
            occurredAt: Math.max(this.#occurredAt, Math.max(0, Math.trunc(Date.now()))),
            payload: snapshotPayload(input.payload),
            type: input.type,
        });
        if (!Value.Check(eventSchema, event)) {
            throw new Error("The Happy agent event is invalid.");
        }
        await saveOriginCursor(database, this.#originCursor);
        await insertEvent(database, event, this.capacity());
        if (this.#moduleListener?.onEventTransactional !== undefined) {
            await this.#moduleListener.onEventTransactional(ctx, event);
        }
        afterCommit(ctx, async (postCommitCtx) => {
            this.publish(event);
            if (this.#moduleListener?.onEvent === undefined) return;
            try {
                await this.#moduleListener.onEvent(postCommitCtx, event);
            } catch {
                // The event is already durable; an observer cannot make the mutation appear failed.
            }
        });
        return event;
    }

    private publish(event: AgentEvent): void {
        if (this.#entries.some((candidate) => candidate.id === event.id)) return;
        this.#occurredAt = Math.max(this.#occurredAt, event.occurredAt);
        this.#entries.push(event);
        while (this.#entries.length > this.capacity()) {
            const removed = this.#entries.shift();
            if (removed !== undefined) this.#originCursor = removed.id;
        }
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // One observer cannot starve the ordered journal or its other subscribers.
            }
        }
    }
}

function emptyRun(runId: string): ActiveRun {
    return {
        acceptedMessageIds: [],
        activeIndex: null,
        activeKind: null,
        argumentBuffers: {},
        blocks: [],
        callIndexes: {},
        hasProviderEvent: false,
        runId,
        stopReason: "stop",
        text: "",
    };
}

function parseActiveRun(value: unknown): ActiveRun {
    if (!Value.Check(activeRunSchema, value)) throw new Error("A durable active run is invalid.");
    return value;
}

function projectProviderEvent(
    previous: ActiveRun,
    event: SessionEvent,
    now: number,
): { readonly rigEvent?: UnknownRecord; readonly run: ActiveRun } {
    let run = structuredClone(previous);
    let rigEvent: UnknownRecord | undefined;
    const messageId = `${run.runId}-assistant`;
    if (event.type === "block_start") {
        run = {
            ...emptyRun(run.runId),
            acceptedMessageIds: run.acceptedMessageIds,
            hasProviderEvent: true,
            stopReason: run.stopReason,
        };
        rigEvent = { messageId, type: "block_start" };
    } else if (event.type === "block_stop") {
        run.activeIndex = null;
        run.activeKind = null;
        rigEvent = { messageId, type: "block_stop" };
    } else if (event.type === "block_reset") {
        run = {
            ...emptyRun(run.runId),
            acceptedMessageIds: run.acceptedMessageIds,
            hasProviderEvent: true,
            stopReason: run.stopReason,
        };
        rigEvent = { messageId, partial: partialMessage(run, now), type: "block_reset" };
    } else if (event.type === "text_start") {
        run.activeIndex = run.blocks.length;
        run.activeKind = "text";
        run.blocks.push({ text: "", type: "text" });
        rigEvent = {
            contentIndex: run.activeIndex,
            messageId,
            partial: partialMessage(run, now),
            type: "text_start",
        };
    } else if (event.type === "text_delta") {
        const index = requireActive(run, "text");
        const block = recordValue(run.blocks[index]);
        const text = typeof block?.text === "string" ? block.text + event.delta : event.delta;
        run.blocks[index] = { text, type: "text" };
        run.text += event.delta;
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "text_delta",
        };
    } else if (event.type === "text_end") {
        const index = requireActive(run, "text");
        const content = String(recordValue(run.blocks[index])?.text ?? "");
        rigEvent = {
            content,
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "text_end",
        };
    } else if (event.type === "reasoning_start") {
        run.activeIndex = run.blocks.length;
        run.activeKind = "reasoning";
        run.blocks.push({ thinking: "", type: "thinking" });
        rigEvent = {
            contentIndex: run.activeIndex,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_start",
        };
    } else if (event.type === "reasoning_delta") {
        const index = requireActive(run, "reasoning");
        const block = recordValue(run.blocks[index]);
        const thinking =
            typeof block?.thinking === "string" ? block.thinking + event.delta : event.delta;
        run.blocks[index] = { thinking, type: "thinking" };
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_delta",
        };
    } else if (event.type === "reasoning_end") {
        const index = requireActive(run, "reasoning");
        const block = recordValue(run.blocks[index]);
        const content = typeof block?.thinking === "string" ? block.thinking : "";
        run.blocks[index] = { thinking: content, type: "thinking" };
        rigEvent = {
            content,
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_end",
        };
    } else if (event.type === "toolcall_start") {
        const index = run.blocks.length;
        run.activeIndex = index;
        run.activeKind = "tool";
        run.callIndexes[event.callId] = index;
        run.argumentBuffers[event.callId] = "";
        run.blocks.push({
            arguments: {},
            id: event.callId,
            name: event.name,
            ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
            providerToolCallId: event.callId,
            type: "toolCall",
            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
        });
        rigEvent = {
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "toolcall_start",
        };
    } else if (event.type === "toolcall_delta") {
        const index = run.callIndexes[event.callId] ?? requireActive(run, "tool");
        run.argumentBuffers[event.callId] = (run.argumentBuffers[event.callId] ?? "") + event.delta;
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "toolcall_delta",
        };
    } else if (event.type === "toolcall_end") {
        const index = run.callIndexes[event.callId] ?? requireActive(run, "tool");
        const block = recordValue(run.blocks[index]) ?? {};
        const toolCall = {
            ...block,
            arguments: parseToolArguments(event.arguments),
            id: event.callId,
            incomplete: event.incomplete,
            type: "toolCall",
        };
        run.blocks[index] = toolCall;
        rigEvent = {
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            toolCall,
            type: "toolcall_end",
        };
    } else if (event.type === "toolcall_result_start") {
        const index = run.callIndexes[event.callId];
        const block = index === undefined ? undefined : recordValue(run.blocks[index]);
        rigEvent = {
            toolCall: {
                ...(block ?? {
                    arguments: {},
                    id: event.callId,
                    name: "server_tool",
                    type: "toolCall",
                }),
            },
            type: "tool_execution_start",
        };
    } else if (event.type === "toolcall_result_delta") {
        rigEvent = {
            display: event.delta,
            toolCallId: event.callId,
            type: "tool_execution_progress",
        };
    } else if (event.type === "toolcall_result_end") {
        const toolName = toolNameForCall(run, event.callId);
        const result = toolExecutionEnd(event.callId, toolName, event.content, event.isError);
        run.blocks.push(result.result);
        rigEvent = { ...result, partial: partialMessage(run, now) };
    } else if (event.type === "retrying") {
        rigEvent = { ...event, messageId };
    } else if (event.type === "done") {
        run.stopReason =
            event.state === "cancelled"
                ? "aborted"
                : event.state === "error"
                  ? "error"
                  : event.state === "length"
                    ? "length"
                    : "stop";
        if (event.state === "error") {
            run.errorMessage = event.message;
        } else {
            // A later successful end supersedes the failure a retry recovered from, so the
            // settlement does not report an error the run no longer has.
            delete run.errorMessage;
        }
    }
    return { ...(rigEvent === undefined ? {} : { rigEvent }), run };
}

function presentedToolCall(call: SessionToolCallBlock): UnknownRecord {
    return {
        arguments: parseToolArguments(call.arguments),
        id: call.callId,
        name: call.name,
        ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
        providerToolCallId: call.callId,
        type: "toolCall",
        ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
    };
}

function toolNameForCall(run: ActiveRun | undefined, callId: string): string {
    if (run === undefined) return "tool";
    const index = run.callIndexes[callId];
    const name = index === undefined ? undefined : recordValue(run.blocks[index])?.name;
    return typeof name === "string" ? name : "tool";
}

function toolExecutionEnd(
    callId: string,
    toolName: string,
    content: readonly SessionOutputBlock[],
    isError: boolean | undefined,
): UnknownRecord {
    // The journal keeps a tool result's text but not its media bytes: the model's context holds
    // the real image, and an unbounded blob repeated through the result, its projection, and
    // every following partial would overrun the durable event payload bound.
    const rendered = content.map((block) =>
        block.type === "text"
            ? { text: block.text, type: "text" }
            : { mediaType: block.mimeType, type: "image" },
    );
    const display =
        content
            .filter(
                (block): block is Extract<SessionOutputBlock, { type: "text" }> =>
                    block.type === "text",
            )
            .map((block) => block.text)
            .join("") || (isError === true ? "Tool failed." : "Tool completed.");
    return {
        result: {
            display,
            ...(isError === true ? { isError: true } : {}),
            rendered,
            toolCallId: callId,
            toolName,
            type: "tool_result",
        },
        type: "tool_execution_end",
    };
}

/** The journal's copy of a tool result keeps text blocks whole and media as metadata only. */
function boundedOutputBlocks(content: readonly SessionOutputBlock[]): readonly UnknownRecord[] {
    return content.map((block) =>
        block.type === "text" ? { ...block } : { mimeType: block.mimeType, type: "image" },
    );
}

function requireActive(run: ActiveRun, kind: ActiveRun["activeKind"]): number {
    if (run.activeIndex === null || run.activeKind !== kind) {
        throw new Error(`The provider emitted a ${kind ?? "stream"} delta without a start event.`);
    }
    return run.activeIndex;
}

function partialMessage(run: ActiveRun, now: number): UnknownRecord {
    return {
        api: "happy-agent",
        content: run.blocks,
        model: "current",
        provider: "happy-agent",
        role: "assistant",
        stopReason: run.stopReason,
        timestamp: now,
        usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    };
}

function parseToolArguments(value: string): UnknownRecord {
    try {
        const parsed: unknown = JSON.parse(value);
        return recordValue(parsed) ?? { value: parsed };
    } catch {
        return { raw: value };
    }
}

function recordValue(value: unknown): UnknownRecord | undefined {
    return Value.Check(unknownRecordSchema, value) ? value : undefined;
}

function snapshotPayload(payload: unknown): unknown {
    return structuredClone(payload);
}

function freezeEvent(event: AgentEvent): AgentEvent {
    deepFreeze(event);
    return event;
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    // A structured clone keeps collections as collections, and their contents are part of the
    // event a listener sees, so they are frozen alongside ordinary properties.
    if (value instanceof Map) {
        for (const [key, entry] of value) {
            deepFreeze(key);
            deepFreeze(entry);
        }
    } else if (value instanceof Set) {
        for (const entry of value) deepFreeze(entry);
    }
    for (const child of Object.values(value)) deepFreeze(child);
}
