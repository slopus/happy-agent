import { describe, expect, it, vi } from "vitest";

import { HappyReducer } from "../sources/HappyReducer.js";
import type { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { HappyAgentUpdate, HappyAgentUpdatesOptions } from "../sources/updates.js";

const CURSOR_0 = "01900000-0000-7000-8000-000000000000";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_9 = "01900000-0000-7000-8000-000000000009";
const CURSOR_10 = "01900000-0000-7000-8000-000000000010";

describe("HappyReducer", () => {
    it("reduces connection state and reports every ordered client update", async () => {
        const harness = reducerHarness();
        const reducer = new HappyReducer(harness.client, { after: CURSOR_0 });
        const observed: Array<{
            update: HappyAgentUpdate;
            connection: string;
        }> = [];
        reducer.subscribeUpdates((update, state) => {
            observed.push({ update, connection: state.connection });
        });

        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
        reducer.start();

        expect(reducer.getState()).toEqual({ agents: {}, connection: "connecting" });
        expect(harness.streams).toHaveLength(1);
        expect(harness.streams[0]?.options.after).toBe(CURSOR_0);
        expect(harness.streams[0]?.options.signal).toBeInstanceOf(AbortSignal);

        harness.streams[0]?.push({ kind: "connected", cursor: CURSOR_0 });
        await vi.waitFor(() => expect(observed).toHaveLength(1));
        expect(reducer.getState()).toEqual({ agents: {}, connection: "connected" });
        expect(observed[0]).toMatchObject({
            connection: "connected",
            update: { kind: "connected", cursor: CURSOR_0 },
        });

        const connectedState = reducer.getState();
        harness.streams[0]?.push({ kind: "state_lost", cursor: CURSOR_9 });
        harness.streams[0]?.push({
            kind: "event",
            cursor: CURSOR_10,
            event: {
                cursor: CURSOR_10,
                occurredAt: 1,
                payload: {},
                type: "config.updated",
            },
        });
        await vi.waitFor(() => expect(observed).toHaveLength(3));

        expect(reducer.getState()).toBe(connectedState);
        expect(observed.map(({ update }) => update.kind)).toEqual([
            "connected",
            "state_lost",
            "event",
        ]);

        harness.streams[0]?.push({ kind: "disconnected", cursor: CURSOR_10 });
        await vi.waitFor(() => expect(observed).toHaveLength(4));
        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
        expect(observed[3]).toMatchObject({
            connection: "disconnected",
            update: { kind: "disconnected", cursor: CURSOR_10 },
        });

        expect(reducer.stop()).toBeUndefined();
        expect(harness.streams[0]?.options.signal?.aborted).toBe(true);
        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
    });

    it("exposes a stable external-store snapshot and subscribes only to state changes", async () => {
        const harness = reducerHarness();
        const reducer = new HappyReducer(harness.client);
        const initialState = reducer.getState();
        const transitions: Array<{
            state: ReturnType<typeof reducer.getState>;
            previousState: ReturnType<typeof reducer.getState>;
        }> = [];
        const observedUpdates: HappyAgentUpdate[] = [];
        const getState = reducer.getState;
        const subscribe = reducer.subscribe;
        const unsubscribe = subscribe((state, previousState) => {
            transitions.push({ state, previousState });
        });
        const subscribeUpdates = reducer.subscribeUpdates;
        subscribeUpdates((update) => observedUpdates.push(update));

        expect(getState()).toBe(initialState);
        expect(initialState).toEqual({ agents: {}, connection: "disconnected" });

        reducer.start();
        const connectingState = getState();
        expect(connectingState).not.toBe(initialState);
        expect(transitions).toHaveLength(1);
        expect(transitions[0]?.state).toBe(connectingState);
        expect(transitions[0]?.previousState).toBe(initialState);

        reducer.start();
        expect(getState()).toBe(connectingState);
        expect(transitions).toHaveLength(1);

        harness.streams[0]?.push({ kind: "connected", cursor: CURSOR_0 });
        await vi.waitFor(() => expect(observedUpdates).toHaveLength(1));
        const connectedState = getState();
        expect(connectedState).not.toBe(connectingState);
        expect(transitions).toHaveLength(2);
        expect(transitions[1]?.state).toBe(connectedState);
        expect(transitions[1]?.previousState).toBe(connectingState);

        harness.streams[0]?.push({ kind: "connected", cursor: CURSOR_0 });
        harness.streams[0]?.push({ kind: "state_lost", cursor: CURSOR_9 });
        await vi.waitFor(() => expect(observedUpdates).toHaveLength(3));
        expect(getState()).toBe(connectedState);
        expect(transitions).toHaveLength(2);

        harness.streams[0]?.push({ kind: "disconnected", cursor: CURSOR_9 });
        await vi.waitFor(() => expect(observedUpdates).toHaveLength(4));
        const disconnectedState = getState();
        expect(disconnectedState).not.toBe(connectedState);
        expect(disconnectedState).not.toBe(initialState);
        expect(transitions).toHaveLength(3);

        expect(reducer.stop()).toBeUndefined();
        expect(getState()).toBe(disconnectedState);
        expect(transitions).toHaveLength(3);

        unsubscribe();
        unsubscribe();
        reducer.start();
        expect(transitions).toHaveLength(3);
        reducer.stop();
    });

    it("tracks draining without hiding daemon-start or journal updates", async () => {
        const harness = reducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observed: Array<{
            update: HappyAgentUpdate;
            connection: string;
        }> = [];
        reducer.subscribeUpdates((update, state) => {
            observed.push({ update, connection: state.connection });
        });

        reducer.start();
        const stream = harness.streams[0];
        stream?.push({ kind: "connected", cursor: CURSOR_0 });
        stream?.push({
            cursor: CURSOR_0,
            daemonId: "daemon-a",
            daemonStartedAt: 1,
            kind: "daemon_started",
            replaced: false,
        });
        await vi.waitFor(() => expect(observed).toHaveLength(2));
        const connectedState = reducer.getState();
        expect(connectedState.connection).toBe("connected");
        expect(observed[1]).toMatchObject({
            connection: "connected",
            update: { kind: "daemon_started", replaced: false },
        });

        stream?.push({
            kind: "event",
            cursor: CURSOR_1,
            event: {
                cursor: CURSOR_1,
                occurredAt: 2,
                payload: { daemonId: "daemon-a", draining: true },
                type: "daemon.draining",
            },
        });
        await vi.waitFor(() => expect(observed).toHaveLength(3));
        const drainingState = reducer.getState();
        expect(drainingState).not.toBe(connectedState);
        expect(drainingState.connection).toBe("draining");
        expect(observed[2]).toMatchObject({
            connection: "draining",
            update: { event: { type: "daemon.draining" }, kind: "event" },
        });

        stream?.push({
            cursor: CURSOR_1,
            daemonId: "daemon-a",
            kind: "draining",
        });
        await vi.waitFor(() => expect(observed).toHaveLength(4));
        expect(reducer.getState()).toBe(drainingState);
        expect(observed[3]).toMatchObject({
            connection: "draining",
            update: { kind: "draining" },
        });

        reducer.stop();
    });

    it("starts once and resumes a later start from the last observed cursor", async () => {
        const harness = reducerHarness();
        const reducer = new HappyReducer(harness.client, { after: CURSOR_0 });
        const observed: HappyAgentUpdate[] = [];
        reducer.subscribeUpdates((update) => observed.push(update));

        reducer.start();
        reducer.start();
        expect(harness.streams).toHaveLength(1);

        harness.streams[0]?.push({ kind: "connected", cursor: CURSOR_0 });
        harness.streams[0]?.push({
            kind: "event",
            cursor: CURSOR_1,
            event: {
                cursor: CURSOR_1,
                occurredAt: 1,
                payload: {},
                type: "config.updated",
            },
        });
        await vi.waitFor(() => expect(observed).toHaveLength(2));

        expect(reducer.stop()).toBeUndefined();
        expect(reducer.stop()).toBeUndefined();
        reducer.start();

        expect(harness.streams).toHaveLength(2);
        expect(harness.streams[1]?.options.after).toBe(CURSOR_1);
        expect(reducer.getState()).toEqual({ agents: {}, connection: "connecting" });

        expect(reducer.stop()).toBeUndefined();
    });

    it("removes listeners and isolates one listener's failure from the others", async () => {
        const harness = reducerHarness();
        const reducer = new HappyReducer(harness.client);
        const observed: HappyAgentUpdate[] = [];
        const removed = vi.fn();

        reducer.subscribeUpdates(() => {
            throw new Error("A consumer failed.");
        });
        reducer.subscribeUpdates((update) => observed.push(update));
        const remove = reducer.subscribeUpdates(removed);
        remove();
        remove();

        reducer.start();
        harness.streams[0]?.push({ kind: "connected", cursor: CURSOR_0 });
        await vi.waitFor(() => expect(observed).toHaveLength(1));

        expect(removed).not.toHaveBeenCalled();
        expect(reducer.getState()).toEqual({ agents: {}, connection: "connected" });

        expect(reducer.stop()).toBeUndefined();
    });

    it("does not apply updates that race with stopping", async () => {
        const harness = reducerHarness({ ignoreAbort: true });
        const reducer = new HappyReducer(harness.client);
        const observed = vi.fn();
        reducer.subscribeUpdates(observed);

        reducer.start();
        const stream = harness.streams[0];
        expect(reducer.stop()).toBeUndefined();
        stream?.push({ kind: "connected", cursor: CURSOR_0 });
        await vi.waitFor(() => expect(stream?.options.signal?.aborted).toBe(true));

        expect(observed).not.toHaveBeenCalled();
        expect(reducer.getState()).toEqual({ agents: {}, connection: "disconnected" });
    });
});

interface ControlledStream extends AsyncIterableIterator<HappyAgentUpdate> {
    readonly options: HappyAgentUpdatesOptions;
    push(update: HappyAgentUpdate): void;
}

function reducerHarness(harnessOptions: { ignoreAbort?: boolean } = {}): {
    client: HappyAgentClient;
    streams: ControlledStream[];
} {
    const streams: ControlledStream[] = [];
    const updates = vi.fn((options: HappyAgentUpdatesOptions = {}) => {
        const stream = controlledStream(options, harnessOptions);
        streams.push(stream);
        return stream;
    });
    return {
        client: { updates } as unknown as HappyAgentClient,
        streams,
    };
}

function controlledStream(
    options: HappyAgentUpdatesOptions,
    harnessOptions: { ignoreAbort?: boolean },
): ControlledStream {
    const queued: HappyAgentUpdate[] = [];
    let waiting: ((result: IteratorResult<HappyAgentUpdate>) => void) | undefined;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        waiting?.({ done: true, value: undefined });
        waiting = undefined;
    };
    if (harnessOptions.ignoreAbort !== true) {
        options.signal?.addEventListener("abort", close, { once: true });
    }

    return {
        options,
        [Symbol.asyncIterator]() {
            return this;
        },
        next() {
            const update = queued.shift();
            if (update !== undefined) {
                return Promise.resolve({ done: false as const, value: update });
            }
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            return new Promise<IteratorResult<HappyAgentUpdate>>((resolve) => {
                waiting = resolve;
            });
        },
        push(update) {
            if (closed) return;
            if (waiting !== undefined) {
                const resolve = waiting;
                waiting = undefined;
                resolve({ done: false, value: update });
                return;
            }
            queued.push(update);
        },
        return() {
            close();
            return Promise.resolve({ done: true as const, value: undefined });
        },
    };
}
