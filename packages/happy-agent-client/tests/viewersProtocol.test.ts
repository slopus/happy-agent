import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    putViewersRequestSchema,
    putViewersResponseSchema,
    viewersUpdatedFrameSchema,
    type PutViewersResponse,
    type ViewersUpdatedFrame,
} from "../sources/protocol/viewers.js";

const streamId = "k8m2q9w1e5r7y3u6i0o2p4s1";
const agent = { type: "agent", id: "a12345678901234567890123" } as const;
const surface = { type: "surface", id: "s12345678901234567890123" } as const;
const cursor = "01900000-0000-7000-8000-000000000001";

afterEach(() => {
    vi.useRealTimers();
});

function sseResponse(...frames: string[]): Response {
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(frames.join("")));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("viewers protocol", () => {
    it("accepts up to eight distinct agent and Surface targets and nothing else", () => {
        const eight = Array.from({ length: 8 }, (_, index) => ({
            type: "agent",
            id: `a${String(index).padStart(23, "0")}`,
        }));
        expect(Value.Check(putViewersRequestSchema, { targets: [] })).toBe(true);
        expect(Value.Check(putViewersRequestSchema, { targets: [agent, surface] })).toBe(true);
        expect(Value.Check(putViewersRequestSchema, { targets: eight })).toBe(true);
        expect(Value.Check(putViewersRequestSchema, { targets: [...eight, surface] })).toBe(false);
        expect(Value.Check(putViewersRequestSchema, { targets: [agent, { ...agent }] })).toBe(
            false,
        );
        expect(
            Value.Check(putViewersRequestSchema, { targets: [{ ...surface, id: "short" }] }),
        ).toBe(false);
        expect(Value.Check(putViewersRequestSchema, { targets: [], extra: 1 })).toBe(false);
        // Agent IDs follow Agent Base: 2 to 32 characters.
        for (const [id, valid] of [
            ["ab", true],
            ["a".repeat(32), true],
            ["a", false],
            ["a".repeat(33), false],
            ["1abc", false],
        ] as const)
            expect(Value.Check(putViewersRequestSchema, { targets: [{ type: "agent", id }] })).toBe(
                valid,
            );
        expect(Value.Check(putViewersRequestSchema, {})).toBe(false);
    });

    it("accepts targets of other types and fields for an older daemon to ignore", () => {
        const file = { type: "file", id: "x", path: "README.md" };
        const valid = (targets: unknown[]): boolean =>
            Value.Check(putViewersRequestSchema, { targets });
        expect(valid([file, agent, { type: "artifact", id: "" }])).toBe(true);
        expect(valid([file, { ...file }])).toBe(false);
        expect(valid(["file"])).toBe(false);
        expect(valid([{ type: "file" }])).toBe(false);
        expect(valid([{ id: "x" }])).toBe(false);
        expect(valid([{ type: 1, id: "x" }])).toBe(false);
        expect(valid([{ type: "file", id: 1 }])).toBe(false);
        // Fields a newer client adds are ignored on every type; the known IDs keep their bounds.
        expect(
            valid([
                { ...agent, path: "x" },
                { ...surface, extra: 1 },
            ]),
        ).toBe(true);
        expect(valid([{ type: "agent", id: "a", path: "x" }])).toBe(false);
        expect(
            Value.Check(putViewersResponseSchema, { targets: [{ target: file, viewers: [] }] }),
        ).toBe(true);
        expect(
            Value.Check(viewersUpdatedFrameSchema, {
                target: file,
                viewer: { userId: "bob", here: true, lastSeenAt: 1 },
            }),
        ).toBe(false);
    });

    it("describes the response lists and the live frame", () => {
        const response: PutViewersResponse = {
            targets: [
                {
                    target: agent,
                    viewers: [
                        { userId: "bob", here: true, lastSeenAt: 1_755_400_000_000 },
                        { userId: "carol", here: false, lastSeenAt: 1_755_399_000_000 },
                    ],
                },
                { target: surface, viewers: [] },
            ],
        };
        expect(Value.Check(putViewersResponseSchema, response)).toBe(true);
        const frame: ViewersUpdatedFrame = {
            target: surface,
            viewer: { userId: "bob", here: false, lastSeenAt: 1_755_400_000_000 },
        };
        expect(Value.Check(viewersUpdatedFrameSchema, frame)).toBe(true);
        expect(Value.Check(viewersUpdatedFrameSchema, { target: surface })).toBe(false);
    });

    it("puts the targets on the encoded stream route and returns the lists", async () => {
        const requests: { method: string; url: string; body: unknown }[] = [];
        const answer: PutViewersResponse = { targets: [{ target: agent, viewers: [] }] };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                requests.push({
                    method: init?.method ?? "GET",
                    url: input.toString(),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                });
                return new Response(JSON.stringify(answer), { status: 200 });
            },
        });
        expect(await client.putViewers("stream/1", { targets: [agent] })).toEqual(answer);
        expect(requests).toEqual([
            {
                method: "PUT",
                url: "http://agent.local/v0/viewers/streams/stream%2F1",
                body: { targets: [agent] },
            },
        ]);
    });

    it("reports a daemon without viewers as an ordinary not-found error", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async () =>
                new Response(JSON.stringify({ error: "Not found.", code: "not_found" }), {
                    status: 404,
                }),
        });
        const error = await client
            .putViewers(streamId, { targets: [] })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({ status: 404, code: "not_found" });
    });

    it("passes viewers.updated frames through updates() and reconnects after the last event", async () => {
        vi.useFakeTimers();
        const frame: ViewersUpdatedFrame = {
            target: agent,
            viewer: { userId: "bob", here: true, lastSeenAt: 1_755_400_000_000 },
        };
        const event = { cursor, occurredAt: 1, payload: {}, type: "config.updated" };
        const later = { ...event, cursor: "01900000-0000-7000-8000-000000000002" };
        const requests: string[] = [];
        const responses = [
            sseResponse(
                `event: hello\ndata: ${JSON.stringify({ connectedAt: 1, cursor, gap: false, resumed: false, streamId })}\n\n`,
                `id: ${later.cursor}\nevent: config.updated\ndata: ${JSON.stringify(later)}\n\n`,
                `event: viewers.updated\ndata: ${JSON.stringify(frame)}\n\n`,
            ),
            sseResponse(
                `event: hello\ndata: ${JSON.stringify({ connectedAt: 2, cursor: later.cursor, gap: false, resumed: true, streamId: "n8m2q9w1e5r7y3u6i0o2p4s2" })}\n\n`,
            ),
        ];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input) => {
                requests.push(input.toString());
                const response = responses.shift();
                if (response === undefined) throw new Error("Unexpected reconnect.");
                return response;
            },
        });
        const controller = new AbortController();
        const updates = client.updates({ signal: controller.signal });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor, streamId },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: later.cursor },
        });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "viewers", frame },
        });
        // The stream ended after the viewer frame; the reconnect resumes after the last event.
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "disconnected", cursor: later.cursor },
        });
        const reconnected = updates.next();
        await vi.advanceTimersByTimeAsync(100);
        await expect(reconnected).resolves.toMatchObject({
            done: false,
            value: { kind: "connected", cursor: later.cursor },
        });
        expect(requests).toEqual([
            "http://agent.local/v0/events/stream",
            `http://agent.local/v0/events/stream?after=${later.cursor}`,
        ]);
        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });
});
