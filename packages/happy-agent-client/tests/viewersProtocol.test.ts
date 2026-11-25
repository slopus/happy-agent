import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

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
        expect(Value.Check(putViewersRequestSchema, { targets: [{ type: "file", id: "x" }] })).toBe(
            false,
        );
        expect(
            Value.Check(putViewersRequestSchema, { targets: [{ ...surface, id: "short" }] }),
        ).toBe(false);
        expect(Value.Check(putViewersRequestSchema, { targets: [{ ...agent, extra: 1 }] })).toBe(
            false,
        );
        expect(Value.Check(putViewersRequestSchema, { targets: [], extra: 1 })).toBe(false);
        expect(Value.Check(putViewersRequestSchema, {})).toBe(false);
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

    it("passes viewers.updated frames through updates() without moving the cursor", async () => {
        const frame: ViewersUpdatedFrame = {
            target: agent,
            viewer: { userId: "bob", here: true, lastSeenAt: 1_755_400_000_000 },
        };
        const event = { cursor, occurredAt: 1, payload: {}, type: "config.updated" };
        const later = { ...event, cursor: "01900000-0000-7000-8000-000000000002" };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async () =>
                sseResponse(
                    `event: hello\ndata: ${JSON.stringify({ connectedAt: 1, cursor, gap: false, resumed: false, streamId })}\n\n`,
                    `event: viewers.updated\ndata: ${JSON.stringify(frame)}\n\n`,
                    `id: ${later.cursor}\nevent: config.updated\ndata: ${JSON.stringify(later)}\n\n`,
                ),
        });
        const controller = new AbortController();
        const updates = client.updates({ signal: controller.signal });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor, streamId },
        });
        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "viewers", frame },
        });
        await expect(updates.next()).resolves.toMatchObject({
            done: false,
            value: { kind: "event", cursor: later.cursor },
        });
        controller.abort();
        await expect(updates.next()).resolves.toEqual({ done: true, value: undefined });
    });
});
