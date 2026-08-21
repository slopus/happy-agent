import type {
    EventStreamFrame,
    HappyAgentClient,
    HappyAgentEvent,
} from "@slopus/happy-agent-client";
import { describe, expect, it, vi } from "vitest";

import { HappyAgentEventHub } from "./HappyAgentEventHub.js";

const CURSOR_0 = "01900000-0000-7000-8000-000000000000";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";

describe("HappyAgentEventHub", () => {
    it("fans one SSE connection out to every ordered follower", async () => {
        const frames: EventStreamFrame[] = [
            {
                hello: { connectedAt: 1, cursor: CURSOR_0, gap: false, resumed: true },
                kind: "hello",
            },
            {
                cursor: CURSOR_1,
                event: event(CURSOR_1),
                kind: "event",
            },
        ];
        const streamEvents = vi.fn(async function* () {
            yield* frames;
        });
        const client = { streamEvents } as unknown as HappyAgentClient;
        const hub = new HappyAgentEventHub(client, CURSOR_0);
        const first: string[] = [];
        const second: string[] = [];

        await Promise.all([
            hub.follow({
                after: CURSOR_0,
                onGap: () => undefined,
                onEvent: (received) => {
                    first.push(received.cursor);
                    return true;
                },
            }),
            hub.follow({
                after: CURSOR_0,
                onGap: () => undefined,
                onEvent: (received) => {
                    second.push(received.cursor);
                    return true;
                },
            }),
        ]);
        await hub.close();

        expect(streamEvents).toHaveBeenCalledTimes(1);
        expect(first).toEqual([CURSOR_1]);
        expect(second).toEqual([CURSOR_1]);
    });

    it("serializes gap recovery before delivering later events", async () => {
        const frames: EventStreamFrame[] = [
            {
                hello: { connectedAt: 1, cursor: CURSOR_1, gap: true, resumed: false },
                kind: "hello",
            },
            {
                cursor: CURSOR_2,
                event: event(CURSOR_2),
                kind: "event",
            },
        ];
        const streamEvents = vi.fn(async function* () {
            yield* frames;
        });
        const client = { streamEvents } as unknown as HappyAgentClient;
        const hub = new HappyAgentEventHub(client, CURSOR_0);
        const recovery = deferred<void>();
        const recoveryStarted = deferred<void>();
        const calls: string[] = [];

        const following = hub.follow({
            after: CURSOR_0,
            onGap: async (cursor) => {
                calls.push(`gap:start:${cursor}`);
                recoveryStarted.resolve();
                await recovery.promise;
                calls.push(`gap:end:${cursor}`);
            },
            onEvent: (received) => {
                calls.push(`event:${received.cursor}`);
                return true;
            },
        });

        await recoveryStarted.promise;
        expect(calls).toEqual([`gap:start:${CURSOR_1}`]);

        recovery.resolve();
        await following;
        expect(calls).toEqual([
            `gap:start:${CURSOR_1}`,
            `gap:end:${CURSOR_1}`,
            `event:${CURSOR_2}`,
        ]);

        const lateCalls: string[] = [];
        await hub.follow({
            after: CURSOR_0,
            onGap: (cursor) => {
                lateCalls.push(`gap:${cursor}`);
            },
            onEvent: (received) => {
                lateCalls.push(`event:${received.cursor}`);
                return true;
            },
        });
        await hub.close();

        expect(lateCalls).toEqual([`gap:${CURSOR_1}`, `event:${CURSOR_2}`]);
    });
});

function event(cursor: string): HappyAgentEvent {
    return {
        cursor,
        occurredAt: 1,
        payload: {},
        type: "config.updated",
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}
