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
        inferenceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
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

/** How many in-memory streamed versions each agent keeps for version lookups. */
const MAX_STREAMED_VERSIONS_PER_AGENT = 1_024;
/** How many agents' streamed versions are kept at once; the least recently streaming go first. */
const MAX_STREAMED_VERSION_AGENTS = 256;

/**
 * The daemon's durable, bounded event journal.
 *
 * Provider `SessionEvent` values are stored verbatim. A separate `rigEvent` projection is attached
 * when Happy Agent's current transcript reducer needs its indexed message shape; it is an adapter, never
 * a replacement for the provider event.
 */
export class EventsModule implements AgentModule<AnyAgentTool> {
    readonly name = "events";
    readonly migrations = eventsMigrations;
    readonly #entries: AgentEvent[] = [];
    /**
     * Where each retained event sits, counted from the first event this process ever held, so a
     * cursor lookup does not scan a window of ten thousand events on every append and replay.
     */
    readonly #positions = new Map<string, number>();
    /** How many events have left the front of the window; positions are offset by it. */
    #dropped = 0;
    /** The newest retained event of each agent. */
    readonly #latestByAgent = new Map<string, string>();
    /**
     * Versions minted by streamed text, newest last, kept only in memory.
     *
     * A streamed fragment is an agent version on the API like any other change, but it is not
     * journaled, so the durable latest-event row does not know it. Version lookups take the newer
     * of the durable answer and this overlay. Each agent keeps a bounded tail: a lookup older
     * than the tail answers with the durable predecessor, which a client detects as a version gap
     * and repairs by refetching, never by adopting a wrong state.
     */
    readonly #streamedVersions = new Map<string, { readonly ids: string[]; occurredAt: number }>();
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
        for (const event of loaded.events) this.#retain(freezeEvent(event));
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

    /** Allocate an opaque resource version without publishing a journal event. */
    resourceVersion(): string {
        return this.#createId();
    }

    latestCursor(agentId: string): string | undefined {
        const latest = this.#latestByAgent.get(agentId);
        return latest !== undefined && this.#positions.has(latest) ? latest : undefined;
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
        const streamed = this.#streamedVersions.get(agentId);
        const cursor = streamed?.ids.at(-1);
        if (streamed === undefined || cursor === undefined) return latest;
        if (latest !== undefined && latest.cursor > cursor) return latest;
        return { cursor, occurredAt: streamed.occurredAt };
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

    /** Agent identities whose runs have started and have not reached a terminal event. */
    activeAgentIds(): readonly string[] {
        return [...this.#runs.keys()];
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
        const durable = await loadPreviousEventCursor(ctx.db, agentId, beforeId);
        const streamed = this.#streamedVersionBefore(agentId, beforeId);
        if (streamed === undefined) return durable;
        return durable !== undefined && durable > streamed ? durable : streamed;
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
        const index = this.#indexOf(after);
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
                const index = this.#indexOf(through);
                if (index >= 0) this.#dropFront(index + 1);
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

        beforeInferenceTransact: async (ctx, scope, inference): Promise<void> => {
            const current = this.#runs.get(scope.agent.id) ?? emptyRun(inference.loopId);
            const next = { ...current, inferenceId: inference.inferenceId };
            await saveActiveRun(ctx.db, scope.agent.id, next);
            afterCommit(ctx, () => {
                this.#runs.set(scope.agent.id, next);
            });
        },

        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            // A tool call is announced when the model starts it and again, with its complete
            // arguments, when it ends. The fragments in between reach no reader.
            if (event.type === "toolcall_delta") return;
            if (event.type === "text_delta" || event.type === "reasoning_delta") {
                this.#streamDelta(scope, event);
                return;
            }
            const journalEvent =
                event.type === "toolcall_end"
                    ? { ...event, arguments: journalToolArguments(event.arguments) }
                    : event;
            await ctx.inTx(async (txCtx) => {
                const current = this.#runs.get(scope.agent.id) ?? emptyRun(this.#createId());
                const projected = projectProviderEvent(
                    { ...current, hasProviderEvent: true },
                    journalEvent,
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
                        event: journalEvent,
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
        const removedThrough = await insertEvent(database, event, this.capacity());
        if (this.#moduleListener?.onEventTransactional !== undefined) {
            await this.#moduleListener.onEventTransactional(ctx, event);
        }
        afterCommit(ctx, async (postCommitCtx) => {
            this.publish(event, removedThrough);
            if (this.#moduleListener?.onEvent === undefined) return;
            try {
                await this.#moduleListener.onEvent(postCommitCtx, event);
            } catch {
                // The event is already durable; an observer cannot make the mutation appear failed.
            }
        });
        return event;
    }

    private publish(event: AgentEvent, removedThrough?: string): void {
        if (this.#positions.has(event.id)) return;
        this.#occurredAt = Math.max(this.#occurredAt, event.occurredAt);
        this.#retain(event);
        let drop = 0;
        while (
            drop < this.#entries.length &&
            (this.#entries.length - drop > this.capacity() ||
                (removedThrough !== undefined && this.#entries[drop]!.id <= removedThrough))
        ) {
            drop += 1;
        }
        if (drop > 0) {
            this.#originCursor = this.#entries[drop - 1]!.id;
            this.#dropFront(drop);
        }
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // One observer cannot starve the ordered journal or its other subscribers.
            }
        }
    }

    /**
     * Passes one streamed text fragment to live subscribers without journaling it.
     *
     * A model streams dozens of fragments a second. Journaling each one cost a transaction with a
     * synced commit and a rewrite of the whole active run, and stalled every request on the
     * daemon. The durable start and end events bracket the block and the end carries its complete
     * text, so replay and restart lose nothing a fragment would have restored: restoration resets
     * an interrupted block either way. The fragment still mints an agent version, in memory.
     */
    #streamDelta(
        scope: AgentModuleScope,
        event: Extract<SessionEvent, { type: "text_delta" | "reasoning_delta" }>,
    ): void {
        const agentId = scope.agent.id;
        const current = this.#runs.get(agentId) ?? emptyRun(this.#createId());
        const kind = event.type === "text_delta" ? "text" : "reasoning";
        const index = requireActive(current, kind);
        const block = recordValue(current.blocks[index]);
        const blocks = [...current.blocks];
        if (kind === "text") {
            const text = typeof block?.text === "string" ? block.text : "";
            blocks[index] = { text: text + event.delta, type: "text" };
        } else {
            const thinking = typeof block?.thinking === "string" ? block.thinking : "";
            blocks[index] = { thinking: thinking + event.delta, type: "thinking" };
        }
        const run: ActiveRun = {
            ...current,
            blocks,
            hasProviderEvent: true,
            ...(kind === "text" ? { text: current.text + event.delta } : {}),
        };
        this.#runs.set(agentId, run);
        const streamed = freezeEvent({
            agentId,
            id: this.#createId(),
            occurredAt: Math.max(this.#occurredAt, Math.max(0, Math.trunc(Date.now()))),
            payload: {
                event: { type: event.type, delta: event.delta },
                rigEvent: {
                    contentIndex: index,
                    delta: event.delta,
                    messageId: run.inferenceId ?? `${run.runId}-assistant`,
                    type: kind === "text" ? "text_delta" : "thinking_delta",
                },
                runId: run.runId,
                provider: scope.agent.provider,
                ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                streamed: true,
            },
            type: "provider.event",
        });
        this.#occurredAt = streamed.occurredAt;
        this.#rememberStreamedVersion(agentId, streamed.id, streamed.occurredAt);
        for (const listener of this.#listeners) {
            try {
                listener(streamed);
            } catch {
                // One observer cannot starve the stream or its other subscribers.
            }
        }
    }

    #rememberStreamedVersion(agentId: string, id: string, occurredAt: number): void {
        let versions = this.#streamedVersions.get(agentId);
        if (versions === undefined) {
            versions = { ids: [], occurredAt };
            if (this.#streamedVersions.size >= MAX_STREAMED_VERSION_AGENTS) {
                const oldest = this.#streamedVersions.keys().next().value;
                if (oldest !== undefined) this.#streamedVersions.delete(oldest);
            }
        } else {
            // Re-inserting keeps the map ordered by last activity, so eviction takes the stalest.
            this.#streamedVersions.delete(agentId);
        }
        versions.ids.push(id);
        versions.occurredAt = occurredAt;
        if (versions.ids.length > MAX_STREAMED_VERSIONS_PER_AGENT) {
            versions.ids.splice(0, versions.ids.length - MAX_STREAMED_VERSIONS_PER_AGENT);
        }
        this.#streamedVersions.set(agentId, versions);
    }

    /** The newest in-memory streamed version strictly before `beforeId`, or the newest overall. */
    #streamedVersionBefore(agentId: string, beforeId: string | undefined): string | undefined {
        const ids = this.#streamedVersions.get(agentId)?.ids;
        if (ids === undefined || ids.length === 0) return undefined;
        if (beforeId === undefined) return ids.at(-1);
        let low = 0;
        let high = ids.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (ids[middle]! < beforeId) low = middle + 1;
            else high = middle;
        }
        return low === 0 ? undefined : ids[low - 1];
    }

    #retain(event: AgentEvent): void {
        this.#positions.set(event.id, this.#dropped + this.#entries.length);
        this.#entries.push(event);
        if (event.agentId !== undefined) this.#latestByAgent.set(event.agentId, event.id);
    }

    #dropFront(count: number): void {
        for (const removed of this.#entries.splice(0, count)) {
            this.#positions.delete(removed.id);
            if (
                removed.agentId !== undefined &&
                this.#latestByAgent.get(removed.agentId) === removed.id
            ) {
                this.#latestByAgent.delete(removed.agentId);
            }
        }
        this.#dropped += count;
    }

    #indexOf(id: string): number {
        const position = this.#positions.get(id);
        return position === undefined ? -1 : position - this.#dropped;
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
    const messageId = run.inferenceId ?? `${run.runId}-assistant`;
    if (event.type === "block_start") {
        run = {
            ...emptyRun(run.runId),
            acceptedMessageIds: run.acceptedMessageIds,
            hasProviderEvent: true,
            ...(run.inferenceId === undefined ? {} : { inferenceId: run.inferenceId }),
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
            ...(run.inferenceId === undefined ? {} : { inferenceId: run.inferenceId }),
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
            type: "toolCall",
        });
        rigEvent = {
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "toolcall_start",
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
        arguments: parseToolArguments(journalToolArguments(call.arguments)),
        id: call.callId,
        name: call.name,
        ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
        type: "toolCall",
    };
}

/** History owns exact input; the replay journal must leave room for its repeated projections. */
function journalToolArguments(argumentsJson: string): string {
    return Buffer.byteLength(argumentsJson, "utf8") <= 1_024 * 1_024
        ? argumentsJson
        : JSON.stringify(
              "Tool arguments are too large for the event journal; see the original message in history.",
          );
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
