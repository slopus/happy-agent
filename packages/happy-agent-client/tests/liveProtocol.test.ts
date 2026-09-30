import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    closeLiveSessionRequestSchema,
    createLiveSessionRequestSchema,
    createLiveSessionResponseSchema,
    liveCredentialSchema,
    liveCredentialRequestSchema,
    liveSessionCreatedPayloadSchema,
    liveSessionSchema,
    liveSessionUpdatedPayloadSchema,
    liveSessionUsageSchema,
    type CreateLiveSessionRequest,
    type HappyAgentEvent,
    type LiveSession,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const session: LiveSession = {
    id: "l1a2b3c4",
    agentId: "a1b2c3d4",
    credential: { type: "codex_subscription", providerId: "codex" },
    watchedAgentIds: [],
    status: "starting",
    usage: { seconds: null, final: false },
    error: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    version,
};
const request: CreateLiveSessionRequest = {
    id: session.id,
    agentId: session.agentId,
    credential: session.credential,
    sdp: "v=0\r\n",
};

describe("Live voice protocol", () => {
    it("requires an explicit credential selection and keeps subscription and API billing distinct", () => {
        expect(Value.Check(createLiveSessionRequestSchema, request)).toBe(true);
        expect(Value.Check(createLiveSessionRequestSchema, { ...request, id: undefined })).toBe(
            true,
        );
        expect(
            Value.Check(createLiveSessionRequestSchema, { ...request, credential: undefined }),
        ).toBe(false);
        for (const type of ["codex_subscription", "openai_api_key"]) {
            expect(
                Value.Check(liveCredentialSchema, { providerId: "configured-account", type }),
            ).toBe(true);
        }
        for (const type of ["auto", "fallback", "codex"]) {
            expect(Value.Check(liveCredentialSchema, { providerId: "codex", type })).toBe(false);
        }
        for (const providerId of ["", " ", "x".repeat(129)]) {
            expect(Value.Check(liveCredentialSchema, { ...session.credential, providerId })).toBe(
                false,
            );
        }
    });

    it.each(["apiKey", "token", "endpoint", "model", "permissionMode"])(
        "rejects the caller's %s override",
        (key) => {
            expect(
                Value.Check(createLiveSessionRequestSchema, { ...request, [key]: "forbidden" }),
            ).toBe(false);
        },
    );

    it.each(["apiKey", "token", "endpoint"])("rejects credential %s material", (key) => {
        expect(
            Value.Check(liveCredentialRequestSchema, { ...session.credential, [key]: "forbidden" }),
        ).toBe(false);
    });

    it("bounds SDP and explicit watched IDs without making omission mean all agents", () => {
        for (const sdp of ["", " \r\n", "x".repeat(65_537)]) {
            expect(Value.Check(createLiveSessionRequestSchema, { ...request, sdp })).toBe(false);
        }
        expect(
            Value.Check(createLiveSessionRequestSchema, { ...request, sdp: "x".repeat(65_536) }),
        ).toBe(true);
        for (const watchedAgentIds of [
            ["same", "same"],
            Array.from({ length: 33 }, (_, i) => `a${i}`),
        ]) {
            expect(
                Value.Check(createLiveSessionRequestSchema, { ...request, watchedAgentIds }),
            ).toBe(false);
        }
        expect(
            Value.Check(createLiveSessionRequestSchema, { ...request, watchedAgentIds: [] }),
        ).toBe(true);
        expect(
            Value.Check(createLiveSessionRequestSchema, { ...request, futureOption: true }),
        ).toBe(false);
    });

    it.each(["", "a", "A1", "123", "a/b", "a b", "a".repeat(33)])(
        "rejects malformed ID %j",
        (id) => {
            expect(Value.Check(createLiveSessionRequestSchema, { ...request, id })).toBe(false);
            expect(Value.Check(createLiveSessionRequestSchema, { ...request, agentId: id })).toBe(
                false,
            );
            expect(
                Value.Check(createLiveSessionRequestSchema, { ...request, watchedAgentIds: [id] }),
            ).toBe(false);
        },
    );

    it("distinguishes unconfirmed duration from zero and final usage", () => {
        expect(Value.Check(liveSessionSchema, session)).toBe(true);
        for (const usage of [
            { seconds: null, final: false },
            { seconds: 0, final: true },
            { seconds: 1.25, final: true },
        ]) {
            expect(Value.Check(liveSessionUsageSchema, usage)).toBe(true);
        }
        for (const usage of [
            { seconds: -1, final: false },
            { seconds: null, final: true },
            { seconds: "12", final: true },
            { seconds: 12 },
        ]) {
            expect(Value.Check(liveSessionUsageSchema, usage)).toBe(false);
        }
        for (const status of ["starting", "active", "closing", "closed", "failed"]) {
            expect(Value.Check(liveSessionSchema, { ...session, status })).toBe(true);
        }
        expect(Value.Check(liveSessionSchema, { ...session, status: "disconnected" })).toBe(false);
        expect(Value.Check(liveSessionSchema, { ...session, futureMetadata: true })).toBe(true);
        expect(Value.Check(closeLiveSessionRequestSchema, {})).toBe(true);
        expect(Value.Check(closeLiveSessionRequestSchema, { abortAgent: true })).toBe(false);
    });

    it("exposes full creation and version-chained updates", () => {
        expect(Value.Check(liveSessionCreatedPayloadSchema, { session, mutationId: "start" })).toBe(
            true,
        );
        const update = {
            sessionId: session.id,
            previousVersion: version,
            version: nextVersion,
            changes: { status: "active", updatedAt: 2 },
            mutationId: "start",
        };
        expect(Value.Check(liveSessionUpdatedPayloadSchema, update)).toBe(true);
        expect(
            Value.Check(liveSessionUpdatedPayloadSchema, {
                ...update,
                changes: { status: "active" },
            }),
        ).toBe(false);
        expect(
            Value.Check(createLiveSessionResponseSchema, {
                session,
                transport: { type: "webrtc", sdp: "answer" },
            }),
        ).toBe(true);
        expect(Value.Check(createLiveSessionResponseSchema, { session })).toBe(false);
    });

    it("sends create/read/close through normal authentication with prefix and abort propagation", async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "happy-token",
            fetch: async (input, init) => {
                requests.push({ url: input.toString(), init });
                return Response.json(
                    requests.length === 1
                        ? { session, transport: { type: "webrtc", sdp: "answer" } }
                        : { session },
                );
            },
        });
        await expect(
            client.createLiveSession(request, { signal: controller.signal }),
        ).resolves.toEqual({ session, transport: { type: "webrtc", sdp: "answer" } });
        await expect(
            client.getLiveSession("id/with space", { signal: controller.signal }),
        ).resolves.toEqual({ session });
        await expect(
            client.closeLiveSession(
                session.id,
                { mutationId: "close" },
                { signal: controller.signal },
            ),
        ).resolves.toEqual({ session });
        expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
            "/prefix/v0/live/sessions",
            "/prefix/v0/live/sessions/id%2Fwith%20space",
            `/prefix/v0/live/sessions/${session.id}/close`,
        ]);
        expect(requests.map(({ init }) => init?.method)).toEqual(["POST", "GET", "POST"]);
        expect(requests[0]!.init?.body).toBe(JSON.stringify(request));
        expect(requests[2]!.init?.body).toBe(JSON.stringify({ mutationId: "close" }));
        for (const item of requests) {
            expect(new URL(item.url).searchParams.get("transport")).toBe("key");
            expect(new Headers(item.init?.headers).get("authorization")).toBe("Bearer happy-token");
            expect(item.init?.signal).toBe(controller.signal);
        }
    });

    it.each([
        [403, "forbidden"],
        [404, "not_found"],
        [409, "conflict"],
        [501, "unsupported"],
        [503, "live_unavailable"],
    ])("preserves %i %s without retries or credential fallback", async (status, code) => {
        let calls = 0;
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () => {
                calls += 1;
                return Response.json({ error: "Live is unavailable.", code, session }, { status });
            },
        });
        await expect(client.createLiveSession(request)).rejects.toMatchObject({
            status,
            code,
            body: { session },
        });
        expect(calls).toBe(1);
    });

    it("does not retry a lost creation response", async () => {
        let calls = 0;
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () => {
                calls += 1;
                throw new TypeError("Connection lost");
            },
        });
        await expect(client.createLiveSession(request)).rejects.toThrow("Connection lost");
        expect(calls).toBe(1);
    });

    it("delivers private lifecycle events through the existing resumable feed", async () => {
        const event: HappyAgentEvent = {
            cursor: nextVersion,
            occurredAt: 2,
            type: "live.session.updated",
            payload: {
                sessionId: session.id,
                previousVersion: version,
                version: nextVersion,
                changes: {
                    status: "closed",
                    usage: { seconds: 2, final: true },
                    endedAt: 2,
                    updatedAt: 2,
                },
            },
        };
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () =>
                new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor: version, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        `id: ${nextVersion}\nevent: live.session.updated\ndata: ${JSON.stringify(event)}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                ),
        });
        const updates = client.updates({ after: version, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({ value: { kind: "connected" } });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });
});
