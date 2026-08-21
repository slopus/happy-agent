import type { HappyAgentClient } from "./HappyAgentClient.js";
import type { HappyReducerConnection, HappyReducerState } from "./HappyReducerState.js";
import type { EventCursor } from "./protocol/common.js";
import type { HappyAgentUpdate } from "./updates.js";

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
 * This first reducer owns only connection state. It keeps the last observed
 * cursor privately so stopping and starting the same reducer resumes rather
 * than silently skipping changes. `getState` and `subscribe` form a read-only,
 * React-compatible external store: a snapshot is replaced only when state
 * changes, and unchanged children retain their references as the state grows.
 * Every SSE update is reduced before update listeners receive it.
 */
export class HappyReducer {
    readonly #client: HappyAgentClient;
    readonly #updateListeners = new Set<UpdateListenerRegistration>();
    readonly #stateListeners = new Set<HappyReducerStateListener>();
    #connectionController: AbortController | undefined;
    #cursor: EventCursor | undefined;
    #state: HappyReducerState = Object.freeze({ connection: "disconnected" });

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

    /** Starts following updates. Starting an already-running reducer does nothing. */
    start(): void {
        if (this.#connectionController !== undefined) return;

        const controller = new AbortController();
        this.#connectionController = controller;
        this.#setConnection("connecting");

        // A synchronous state subscriber may stop or replace this run.
        if (this.#connectionController !== controller) return;
        void this.#follow(controller);
    }

    /** Stops synchronously. Any late updates from the old stream are ignored. */
    stop(): void {
        const controller = this.#connectionController;
        if (controller === undefined) {
            this.#setConnection("disconnected");
            return;
        }

        this.#connectionController = undefined;
        controller.abort();
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
                this.#setConnection("disconnected");
            }
        }
    }

    #apply(update: HappyAgentUpdate): void {
        if (update.cursor !== undefined) this.#cursor = update.cursor;
        if (update.kind === "connected") this.#setConnection("connected");
        else if (update.kind === "disconnected") this.#setConnection("disconnected");

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

        // Copy only the changed path. Future state branches remain referentially
        // stable when an unrelated branch changes.
        const state: HappyReducerState = Object.freeze({ ...previousState, connection });
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
}
