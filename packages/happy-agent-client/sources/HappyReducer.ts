import type { HappyAgentClient } from "./HappyAgentClient.js";
import {
    createHappyReducerAgentReplica,
    reduceHappyReducerAgentEvent,
    type HappyReducerAgentReplica,
} from "./HappyReducerAgentReplica.js";
import { HappyReducerRecentEvents } from "./HappyReducerRecentEvents.js";
import type {
    HappyReducerAgentState,
    HappyReducerConnection,
    HappyReducerState,
} from "./HappyReducerState.js";
import type { AgentActivityResponse } from "./protocol/agents.js";
import type { Cuid2, EventCursor } from "./protocol/common.js";
import type { HappyAgentEvent } from "./protocol/events.js";
import type { HappyAgentUpdate } from "./updates.js";

const MAX_CONCURRENT_AGENT_SYNCS = 3;
const INITIAL_AGENT_SYNC_RETRY_MS = 100;
const MAX_AGENT_SYNC_RETRY_MS = 10_000;

/** Initial synchronization options for a reducer. */
export interface HappyReducerOptions {
    /** The last event already reflected in state. */
    after?: EventCursor | undefined;
}

/** Receives an update after it has been reduced into the supplied state. */
export type HappyReducerUpdateListener = (
    update: HappyAgentUpdate,
    state: HappyReducerState,
) => void;

/** Receives a new immutable state snapshot and the snapshot it replaced. */
export type HappyReducerStateListener = (
    state: HappyReducerState,
    previousState: HappyReducerState,
) => void;

/** Removes one listener registration. Calling it more than once is harmless. */
export type HappyReducerUnsubscribe = () => void;

interface UpdateListenerRegistration {
    listener: HappyReducerUpdateListener;
}

/**
 * The stateful layer over `HappyAgentClient.updates()`.
 *
 * It keeps connection state and visibility-selected agent replicas. The SSE
 * feed opens before queued agent snapshots, recent events rebase snapshots
 * that race the stream, and dirty replicas refresh through a bounded queue.
 * `getState` and `subscribe` form a read-only, React-compatible external store:
 * a snapshot is replaced only when state changes, and unchanged children keep
 * their references. Every SSE update is reduced before update listeners see it.
 */
export class HappyReducer {
    readonly #client: HappyAgentClient;
    readonly #updateListeners = new Set<UpdateListenerRegistration>();
    readonly #stateListeners = new Set<HappyReducerStateListener>();
    readonly #trackedAgentIds = new Set<Cuid2>();
    readonly #visibleAgentCounts = new Map<Cuid2, number>();
    readonly #dirtyAgentIds = new Set<Cuid2>();
    readonly #agentReplicas = new Map<Cuid2, HappyReducerAgentReplica>();
    readonly #agentSyncs = new Map<Cuid2, AbortController>();
    readonly #agentSyncRetryDelays = new Map<Cuid2, number>();
    readonly #agentSyncRetryTimers = new Map<Cuid2, ReturnType<typeof setTimeout>>();
    readonly #recentEvents = new HappyReducerRecentEvents();
    #connectionController: AbortController | undefined;
    #agentSyncEnabled = false;
    #agentSyncConnected = false;
    #cursor: EventCursor | undefined;
    #state: HappyReducerState = { agents: {}, connection: "disconnected" };

    constructor(client: HappyAgentClient, options: HappyReducerOptions = {}) {
        this.#client = client;
        this.#cursor = options.after;
    }

    /** Returns the current immutable snapshot, stable until state changes. */
    readonly getState = (): HappyReducerState => this.#state;

    /**
     * Subscribes to state changes using Zustand-style `(state, previousState)`
     * arguments. Duplicate updates that do not change state do not notify it.
     */
    readonly subscribe = (listener: HappyReducerStateListener): HappyReducerUnsubscribe => {
        this.#stateListeners.add(listener);
        return () => {
            this.#stateListeners.delete(listener);
        };
    };

    /** Subscribes to every ordered update from the SSE feed without starting the reducer. */
    readonly subscribeUpdates = (listener: HappyReducerUpdateListener): HappyReducerUnsubscribe => {
        const registration = { listener };
        this.#updateListeners.add(registration);
        return () => {
            this.#updateListeners.delete(registration);
        };
    };

    /**
     * Marks an agent visible and queues an authoritative sync at visible priority.
     * The returned idempotent cleanup lowers it to background priority; the reducer
     * keeps the agent synchronized while it remains tracked.
     */
    readonly agentVisible = (agentId: Cuid2): HappyReducerUnsubscribe => {
        this.#trackedAgentIds.add(agentId);
        const previousCount = this.#visibleAgentCounts.get(agentId) ?? 0;
        this.#visibleAgentCounts.set(agentId, previousCount + 1);
        if (previousCount === 0) this.#markAgentDirty(agentId);

        let visible = true;
        return () => {
            if (!visible) return;
            visible = false;
            const count = this.#visibleAgentCounts.get(agentId);
            if (count === undefined || count <= 1) this.#visibleAgentCounts.delete(agentId);
            else this.#visibleAgentCounts.set(agentId, count - 1);
        };
    };

    /** Starts following updates. Starting an already-running reducer does nothing. */
    start(): void {
        if (this.#connectionController !== undefined) return;

        const controller = new AbortController();
        this.#connectionController = controller;
        this.#setConnection("connecting");

        // A synchronous state subscriber may stop or replace this run.
        if (this.#connectionController !== controller) return;
        void this.#follow(controller);
        if (this.#connectionController !== controller) return;

        this.#agentSyncEnabled = true;
        this.#markAllAgentsDirty();
    }

    /** Stops synchronously. Any late updates from the old stream are ignored. */
    stop(): void {
        const controller = this.#connectionController;
        if (controller === undefined) {
            this.#setConnection("disconnected");
            return;
        }

        this.#connectionController = undefined;
        this.#agentSyncEnabled = false;
        this.#agentSyncConnected = false;
        controller.abort();
        this.#stopAgentSyncs();
        this.#recentEvents.invalidate();
        for (const agentId of this.#trackedAgentIds) this.#dirtyAgentIds.add(agentId);
        this.#setConnection("disconnected");
    }

    async #follow(controller: AbortController): Promise<void> {
        try {
            for await (const update of this.#client.updates({
                ...(this.#cursor === undefined ? {} : { after: this.#cursor }),
                signal: controller.signal,
            })) {
                if (controller.signal.aborted) return;
                this.#apply(update);
            }
        } catch {
            // `updates()` handles transport retries itself. If a custom client
            // still terminates unexpectedly, the reducer settles disconnected
            // and remains restartable instead of leaking an unhandled promise.
        } finally {
            if (this.#connectionController === controller) {
                this.#connectionController = undefined;
                this.#agentSyncEnabled = false;
                this.#agentSyncConnected = false;
                this.#stopAgentSyncs();
                this.#recentEvents.invalidate();
                for (const agentId of this.#trackedAgentIds) this.#dirtyAgentIds.add(agentId);
                this.#setConnection("disconnected");
            }
        }
    }

    #apply(update: HappyAgentUpdate): void {
        if (update.cursor !== undefined) this.#cursor = update.cursor;
        if (update.kind === "connected") {
            this.#agentSyncConnected = true;
            this.#setConnection("connected");
            this.#drainAgentSyncQueue();
        } else if (update.kind === "daemon_started") {
            if (update.replaced) {
                this.#recentEvents.invalidate();
                this.#markAllAgentsDirty();
            }
        } else if (update.kind === "draining") {
            this.#agentSyncConnected = true;
            this.#setConnection("draining");
            this.#drainAgentSyncQueue();
        } else if (update.kind === "disconnected") {
            this.#agentSyncConnected = false;
            this.#setConnection("disconnected");
        } else if (update.kind === "state_lost") {
            this.#recentEvents.invalidate();
            this.#markAllAgentsDirty();
        } else {
            if (update.event.type === "daemon.draining") this.#setConnection("draining");
            this.#recentEvents.remember(update.event, Date.now());
            this.#applyAgentEvent(update.event);
        }

        const state = this.#state;

        for (const { listener } of Array.from(this.#updateListeners)) {
            try {
                listener(update, state);
            } catch {
                // One consumer must not interrupt the shared update stream or
                // prevent the remaining consumers from receiving this update.
            }
        }
    }

    #setConnection(connection: HappyReducerConnection): void {
        const previousState = this.#state;
        if (previousState.connection === connection) return;

        const state: HappyReducerState = { ...previousState, connection };
        this.#publishState(state, previousState);
    }

    #applyAgentEvent(event: HappyAgentEvent): void {
        for (const [agentId, replica] of Array.from(this.#agentReplicas)) {
            const result = reduceHappyReducerAgentEvent(replica, event);
            if (result.replica !== replica) this.#commitAgentReplica(agentId, result.replica);
            if (result.dirty) this.#markAgentDirty(agentId);
        }
    }

    #commitAgentReplica(agentId: Cuid2, replica: HappyReducerAgentReplica): void {
        const previousReplica = this.#agentReplicas.get(agentId);
        this.#agentReplicas.set(agentId, replica);
        if (previousReplica?.state === replica.state) return;

        const previousState = this.#state;
        const agents: Readonly<Record<Cuid2, HappyReducerAgentState>> = {
            ...previousState.agents,
            [agentId]: replica.state,
        };
        this.#publishState({ ...previousState, agents }, previousState);
    }

    #publishState(state: HappyReducerState, previousState: HappyReducerState): void {
        this.#state = state;

        for (const listener of Array.from(this.#stateListeners)) {
            try {
                listener(state, previousState);
            } catch {
                // A broken view must not prevent other subscribers from seeing
                // the committed state transition.
            }
        }
    }

    #markAllAgentsDirty(): void {
        for (const agentId of this.#trackedAgentIds) this.#dirtyAgentIds.add(agentId);
        this.#drainAgentSyncQueue();
    }

    #markAgentDirty(agentId: Cuid2): void {
        this.#dirtyAgentIds.add(agentId);
        this.#drainAgentSyncQueue();
    }

    #drainAgentSyncQueue(): void {
        if (
            !this.#agentSyncEnabled ||
            !this.#agentSyncConnected ||
            this.#connectionController === undefined
        ) {
            return;
        }
        while (this.#agentSyncs.size < MAX_CONCURRENT_AGENT_SYNCS) {
            const agentId = this.#nextDirtyAgent();
            if (agentId === undefined) return;
            this.#dirtyAgentIds.delete(agentId);
            const controller = new AbortController();
            this.#agentSyncs.set(agentId, controller);
            void this.#syncAgent(agentId, controller);
        }
    }

    #nextDirtyAgent(): Cuid2 | undefined {
        let background: Cuid2 | undefined;
        for (const agentId of this.#dirtyAgentIds) {
            if (this.#agentSyncs.has(agentId) || this.#agentSyncRetryTimers.has(agentId)) {
                continue;
            }
            if ((this.#visibleAgentCounts.get(agentId) ?? 0) > 0) return agentId;
            background ??= agentId;
        }
        return background;
    }

    async #syncAgent(agentId: Cuid2, controller: AbortController): Promise<void> {
        const startedAt = Date.now();
        const recentEventsEpoch = this.#recentEvents.epoch;
        const recentEventsCheckpoint = this.#recentEvents.checkpoint();
        try {
            const bootstrap = await this.#client.getAgentBootstrap(agentId, {
                signal: controller.signal,
            });
            if (controller.signal.aborted || this.#agentSyncs.get(agentId) !== controller) return;

            let activity: AgentActivityResponse;
            let activityCursors = {
                processes: bootstrap.cursor,
                subagents: bootstrap.cursor,
            };
            if (bootstrap.processes !== undefined && bootstrap.subagents !== undefined) {
                activity = {
                    processes: bootstrap.processes,
                    subagents: bootstrap.subagents,
                };
            } else {
                const streamCursor = this.#cursor;
                const fallbackCursor =
                    streamCursor !== undefined && streamCursor > bootstrap.cursor
                        ? streamCursor
                        : bootstrap.cursor;
                const fallback = await this.#client.getAgentActivity(agentId, {
                    signal: controller.signal,
                });
                if (controller.signal.aborted || this.#agentSyncs.get(agentId) !== controller) {
                    return;
                }
                activity = {
                    processes: bootstrap.processes ?? fallback.processes,
                    subagents: bootstrap.subagents ?? fallback.subagents,
                };
                activityCursors = {
                    processes:
                        bootstrap.processes === undefined ? fallbackCursor : bootstrap.cursor,
                    subagents:
                        bootstrap.subagents === undefined ? fallbackCursor : bootstrap.cursor,
                };
            }

            const streamCursor = this.#cursor;
            const questionCursor =
                streamCursor !== undefined && streamCursor > bootstrap.cursor
                    ? streamCursor
                    : bootstrap.cursor;
            const { question } = await this.#client.getPendingQuestion(agentId, {
                signal: controller.signal,
            });
            if (controller.signal.aborted || this.#agentSyncs.get(agentId) !== controller) return;

            let replica = createHappyReducerAgentReplica(
                bootstrap,
                activity,
                activityCursors,
                question,
                questionCursor,
                this.#agentReplicas.get(agentId),
            );
            let dirty = false;
            const now = Date.now();
            for (const event of this.#recentEvents.since(recentEventsCheckpoint, now)) {
                const result = reduceHappyReducerAgentEvent(replica, event);
                replica = result.replica;
                dirty ||= result.dirty;
            }
            this.#commitAgentReplica(agentId, replica);
            this.#agentSyncRetryDelays.delete(agentId);

            if (dirty || !this.#recentEvents.isCompleteSince(recentEventsEpoch, startedAt, now)) {
                this.#dirtyAgentIds.add(agentId);
            }
        } catch {
            const shouldRetry =
                !controller.signal.aborted && this.#agentSyncs.get(agentId) === controller;
            controller.abort();
            if (shouldRetry) {
                this.#dirtyAgentIds.add(agentId);
                this.#scheduleAgentSyncRetry(agentId);
            }
        } finally {
            if (this.#agentSyncs.get(agentId) === controller) this.#agentSyncs.delete(agentId);
            this.#drainAgentSyncQueue();
        }
    }

    #scheduleAgentSyncRetry(agentId: Cuid2): void {
        if (this.#agentSyncRetryTimers.has(agentId) || !this.#agentSyncEnabled) return;
        const delay = this.#agentSyncRetryDelays.get(agentId) ?? INITIAL_AGENT_SYNC_RETRY_MS;
        this.#agentSyncRetryDelays.set(agentId, Math.min(delay * 2, MAX_AGENT_SYNC_RETRY_MS));
        const timer = setTimeout(() => {
            if (this.#agentSyncRetryTimers.get(agentId) !== timer) return;
            this.#agentSyncRetryTimers.delete(agentId);
            this.#drainAgentSyncQueue();
        }, delay);
        this.#agentSyncRetryTimers.set(agentId, timer);
    }

    #stopAgentSyncs(): void {
        for (const controller of this.#agentSyncs.values()) controller.abort();
        this.#agentSyncs.clear();
        for (const timer of this.#agentSyncRetryTimers.values()) clearTimeout(timer);
        this.#agentSyncRetryTimers.clear();
        this.#agentSyncRetryDelays.clear();
    }
}
