import { afterEach, describe, expect, it, vi } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { HappyAgentEvent } from "../sources/protocol/events.js";

const CURSOR_0 = "01900000-0000-7000-8000-000000000000";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";
const CURSOR_4 = "01900000-0000-7000-8000-000000000004";
const CURSOR_9 = "01900000-0000-7000-8000-000000000009";
const CURSOR_10 = "01900000-0000-7000-8000-000000000010";

afterEach(() => {
    vi.useRealTimers();
});

describe("HappyAgentClient updates", () => {
    it("reconnects from the last accepted cursor and filters duplicate or outdated events", async () => {
        vi.useFakeTimers();
        const requests: string[] = [];
        const responses = [
            sseResponse(
                hello(CURSOR_3, false, true),
                update(CURSOR_1),
                update(CURSOR_2),
                update(CURSOR_1),
                update(CURSOR_3),
            ),
            sseResponse(hello(CURSOR_4, false, true), update(CURSOR_2), update(CURSOR_4)),
        ];
        const fetch: typeof globalThis.fetch = async (input) => {
            requests.push(input.toString());
            const response = responses.shift();
            if (response === undefined) throw new Error("Unexpected reconnect.");
            return response;
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ after: CURSOR_0, signal: controller.signal });

        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_0 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_1 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_2 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_3 },
        });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "disconnected", cursor: CURSOR_3 },
        });

        const reconnected = updates.next();
        await vi.advanceTimersByTimeAsync(100);
        await expect(reconnected).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_3 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_4 },
        });

        expect(requests).toEqual([
            `http://agent.local/v0/events/stream?after=${CURSOR_0}`,
            `http://agent.local/v0/events/stream?after=${CURSOR_3}`,
        ]);

        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("announces a lost state with the authoritative cursor before later events", async () => {
        const fetch: typeof globalThis.fetch = async () =>
            sseResponse(hello(CURSOR_9, true, false), update(CURSOR_10));
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ after: CURSOR_0, signal: controller.signal });

        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_9 },
        });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "state_lost", cursor: CURSOR_9 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_10 },
        });

        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("survives connection failures and reports only connection-state transitions", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const fetch: typeof globalThis.fetch = async () => {
            attempts += 1;
            if (attempts <= 2) throw new TypeError("The network is offline.");
            return sseResponse(hello(CURSOR_1, false, true), update(CURSOR_1));
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ after: CURSOR_0, signal: controller.signal });

        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "disconnected", cursor: CURSOR_0 },
        });

        const connected = updates.next();
        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(200);
        await expect(connected).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_0 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_1 },
        });

        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("resumes after a response body fails partway through an event stream", async () => {
        vi.useFakeTimers();
        const responses = [
            brokenSseResponse(hello(CURSOR_1, false, true), update(CURSOR_1)),
            sseResponse(hello(CURSOR_2, false, true), update(CURSOR_2)),
        ];
        const fetch: typeof globalThis.fetch = async () => {
            const response = responses.shift();
            if (response === undefined) throw new Error("Unexpected reconnect.");
            return response;
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ after: CURSOR_0, signal: controller.signal });

        await expect(updates.next()).resolves.toMatchObject({ value: { kind: "connected" } });
        await expect(updates.next()).resolves.toMatchObject({
            value: { kind: "event", cursor: CURSOR_1 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            value: { kind: "disconnected", cursor: CURSOR_1 },
        });

        const reconnected = updates.next();
        await vi.advanceTimersByTimeAsync(100);
        await expect(reconnected).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_1 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            value: { kind: "event", cursor: CURSOR_2 },
        });

        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("starts at a fresh hello cursor and ignores events at or behind it", async () => {
        const fetch: typeof globalThis.fetch = async () =>
            sseResponse(hello(CURSOR_3, false, false), update(CURSOR_2), update(CURSOR_4));
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ signal: controller.signal });

        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_3 },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: CURSOR_4 },
        });

        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("stops an in-flight reconnect delay as soon as the caller aborts", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const fetch: typeof globalThis.fetch = async () => {
            attempts += 1;
            throw new TypeError("The network is offline.");
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const updates = client.updates({ after: CURSOR_0, signal: controller.signal });

        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "disconnected", cursor: CURSOR_0 },
        });
        const reconnecting = updates.next();
        controller.abort();

        await expect(reconnecting).resolves.toEqual({ done: true, value: undefined });
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

function hello(cursor: string, gap: boolean, resumed: boolean): string {
    return `event: hello\ndata: ${JSON.stringify({ connectedAt: 1, cursor, gap, resumed })}\n\n`;
}

function update(cursor: string): string {
    const event: HappyAgentEvent = {
        cursor,
        occurredAt: 1,
        payload: {},
        type: "config.updated",
    };
    return `id: ${cursor}\nevent: config.updated\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(...frames: string[]): Response {
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(frames.join("")));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function brokenSseResponse(...frames: string[]): Response {
    let delivered = false;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            if (!delivered) {
                delivered = true;
                controller.enqueue(new TextEncoder().encode(frames.join("")));
                return;
            }
            controller.error(new Error("The response body disconnected."));
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
