import { afterEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
    createLiveProviderTransport,
    LiveProviderError,
    type LiveProviderDependencies,
    type LiveProviderEvent,
} from "../sources/live/impl/liveProviderTransport.js";

class Socket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    bufferedAmount = 0;
    sent: unknown[] = [];
    terminated = false;
    open() {
        this.readyState = WebSocket.OPEN;
        this.emit("open");
    }
    event(value: unknown) {
        this.emit("message", Buffer.from(JSON.stringify(value)), false);
    }
    send(value: string, callback: (error?: Error) => void) {
        this.sent.push(JSON.parse(value));
        callback();
    }
    close() {
        this.readyState = WebSocket.CLOSING;
    }
    terminate() {
        this.terminated = true;
        this.readyState = WebSocket.CLOSED;
    }
    providerClose(code = 1000) {
        this.readyState = WebSocket.CLOSED;
        this.emit("close", code);
    }
}
function fixture(native = false, extra: Partial<LiveProviderDependencies> = {}) {
    const socket = new Socket();
    const events: LiveProviderEvent[] = [];
    const requests: { url: string; options: RequestInit | undefined }[] = [];
    let attachUrl = "";
    const controller = new AbortController();
    const deps: LiveProviderDependencies = {
        fetch: async (url, options) => {
            requests.push({ url: String(url), options });
            return native
                ? new Response("v=answer\r\n", {
                      status: 201,
                      headers: { location: "/v1/live/rtc_test" },
                  })
                : Response.json(
                      {
                          session: { id: "sess_test" },
                          transport: { type: "webrtc", sdp: "v=answer\r\n" },
                      },
                      { status: 201 },
                  );
        },
        connect: (url) => {
            attachUrl = url;
            queueMicrotask(() => socket.open());
            return socket as unknown as WebSocket;
        },
        setupTimeoutMs: 100,
        readyTimeoutMs: 1000,
        closeTimeoutMs: 20,
        ...extra,
    };
    const options = {
        credential: native
            ? {
                  type: "codex_subscription" as const,
                  token: "test-token",
                  accountId: "test-account",
              }
            : { type: "openai_api_key" as const, token: "test-token" },
        sdp: "v=offer\r\n",
        instructions: "Fixture only.",
        signal: controller.signal,
        onEvent: (event: LiveProviderEvent) => events.push(event),
    };
    return {
        socket,
        events,
        requests,
        controller,
        start: () => createLiveProviderTransport(options, deps),
        ready: () =>
            socket.event({
                type: native ? "session.updated" : "session.started",
                session: { id: "sess_test" },
            }),
        attachUrl: () => attachUrl,
    };
}

describe("Live provider dialect and lifecycle", () => {
    afterEach(() => vi.useRealTimers());
    test("native deliberate close completes a real WebSocket closing handshake", async () => {
        const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture address.");
        server.on("connection", (socket) =>
            socket.send(
                JSON.stringify({ type: "session.started", session: { id: "native_session" } }),
            ),
        );
        const events: LiveProviderEvent[] = [];
        const transport = await createLiveProviderTransport(
            {
                credential: { type: "codex_subscription", token: "fixture" },
                sdp: "v=offer",
                instructions: "fixture",
                signal: new AbortController().signal,
                onEvent: (event) => events.push(event),
            },
            {
                fetch: async () =>
                    new Response("v=answer", {
                        status: 201,
                        headers: { location: "/v1/live/rtc_fixture" },
                    }),
                connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
                setupTimeoutMs: 1000,
                readyTimeoutMs: 1000,
                closeTimeoutMs: 1000,
            },
        );
        try {
            await expect.poll(() => events).toContainEqual({ type: "ready" });
            await transport.close();
            expect(events.at(-1)).toEqual({ type: "ended", orderly: true, error: null });
        } finally {
            transport.dispose();
            for (const socket of server.clients) socket.terminate();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
    test("public create and attach require actual readiness, real timing and nested delegation metadata", async () => {
        const f = fixture();
        const transport = await f.start();
        expect(transport.sdp).toBe("v=answer\r\n");
        expect(f.attachUrl()).toBe("wss://api.openai.com/v1/live/sessions/sess_test/attach");
        expect(JSON.parse(String(f.requests[0]!.options?.body))).toMatchObject({
            transport: { type: "webrtc", sdp: "v=offer\r\n" },
            session: {
                model: "gpt-live-1",
                audio: { output: { voice: "cove" } },
                delegation: { type: "client" },
            },
        });
        expect(f.events).toEqual([]);
        await expect(
            transport.append({ delegationId: null, text: "premature", speakable: false }),
        ).rejects.toBeInstanceOf(LiveProviderError);
        f.ready();
        f.socket.event({
            type: "session.input_transcript.delta",
            delta: "hello",
            start_ms: 2,
            end_ms: 8,
        });
        f.socket.event({
            type: "session.delegation.created",
            delegation: { id: "delegation_1", type: "delegation", target: "client" },
        });
        expect(f.events).toEqual([
            { type: "ready" },
            { type: "transcript", role: "user", text: "hello", startMs: 2, endMs: 8 },
            { type: "delegation", delegationId: "delegation_1" },
        ]);
        transport.dispose();
    });
    test("native preserves the call ID and untimed fragments without repeating aggregate turns", async () => {
        const f = fixture(true);
        const transport = await f.start();
        expect(f.attachUrl()).toBe("wss://api.openai.com/v1/live/rtc_test");
        expect(f.requests[0]!.url).toBe(
            "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
        );
        expect(JSON.parse(String(f.requests[0]!.options?.body))).toMatchObject({
            sdp: "v=offer\r\n",
            session: { model: "gpt-live-1-codex", audio: { output: { voice: "cove" } } },
        });
        f.ready();
        for (let i = 0; i < 2; i++)
            f.socket.event({
                type: "input_transcript.added",
                item: { id: "input-1", type: "input_transcript", text: "hello" },
            });
        f.socket.event({
            type: "turn.done",
            turn: { id: "turn-1", role: "user", transcript: "hello" },
        });
        f.socket.event({
            type: "delegation.created",
            item: {
                id: "d1",
                type: "delegation",
                target: "client",
                content: [{ type: "input_text", text: "do this" }],
            },
        });
        expect(f.events).toEqual([
            { type: "ready" },
            { type: "transcript", role: "user", text: "hello" },
            { type: "delegation", delegationId: "d1", text: "do this" },
        ]);
        const closing = transport.close();
        f.socket.providerClose();
        await closing;
        expect(f.events.at(-1)).toEqual({ type: "ended", orderly: true, error: null });
        expect(f.events.some((event) => event.type === "usage")).toBe(false);
    });
    test("tolerates observed native timing, handoff metadata, usage and audio echoes", async () => {
        const f = fixture(true);
        const transport = await f.start();
        f.ready();
        f.socket.event({
            type: "input_transcript.added",
            start_ms: 1600,
            end_ms: 1800,
            item: { id: "input", type: "input_transcript", text: " Open" },
        });
        f.socket.event({
            type: "output_transcript.added",
            start_ms: 1800,
            end_ms: 2000,
            item: { id: "output", type: "output_transcript", text: "Sure." },
        });
        f.socket.event({
            type: "delegation.created",
            offset_ms: 6400,
            item: {
                id: "delegation",
                type: "delegation",
                target: "client",
                content: [{ type: "input_text", text: "Open the project." }],
                handoff_id: "handoff_1",
                user_bidi_turn_id: "turn",
            },
        });
        f.socket.event({
            type: "session.usage.updated",
            usage: { audio_duration_ms: 6800, backend_model_usage: [] },
            usage_limit: { status: null, reset_seconds: null },
        });
        f.socket.event({ type: "session.input_audio.append", audio: "AAAA" });
        f.socket.event({ type: "turn.created", turn: { id: "turn", transcript: " Open" } });
        f.socket.event({ type: "turn.delta", turn: { id: "turn", transcript: " Open" } });
        f.socket.event({ type: "turn.done", turn: { id: "turn", transcript: " Open" } });
        expect(f.events).toEqual([
            { type: "ready" },
            { type: "transcript", role: "user", text: " Open" },
            { type: "transcript", role: "assistant", text: "Sure." },
            { type: "delegation", delegationId: "delegation", text: "Open the project." },
        ]);
        transport.dispose();
    });
    test("cumulative usage snapshots are not summed and final usage precedes failed close", async () => {
        const f = fixture();
        const transport = await f.start();
        f.ready();
        f.socket.event({ type: "session.usage.updated", usage: { seconds: 12 } });
        f.socket.event({ type: "session.usage.updated", usage: { seconds: 15 } });
        const closing = transport.close();
        f.socket.event({
            type: "session.closed",
            session: { id: "sess_test" },
            reason: "connection_lost",
            usage: { seconds: 16 },
        });
        await closing;
        expect(f.events.filter((event) => event.type === "usage")).toEqual([
            { type: "usage", seconds: 12, final: false },
            { type: "usage", seconds: 15, final: false },
            { type: "usage", seconds: 16, final: true },
        ]);
        expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
        expect(f.socket.terminated).toBe(true);
    });
    test("a public socket close alone and a native unready close both fail", async () => {
        for (const native of [false, true]) {
            const f = fixture(native);
            const transport = await f.start();
            if (!native) f.ready();
            const closing = transport.close();
            f.socket.providerClose();
            await closing;
            expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
            expect(f.events.some((event) => event.type === "usage")).toBe(false);
        }
    });
    test("both dialects chunk UTF8 within limits and keep quiet and speakable updates distinct", async () => {
        for (const native of [false, true]) {
            const f = fixture(native);
            const transport = await f.start();
            f.ready();
            await transport.append({ delegationId: "d1", text: "🙂".repeat(251), speakable: true });
            expect(f.socket.sent).toHaveLength(3);
            const frames = f.socket.sent as Array<{
                type: string;
                content: string | { text: string }[];
            }>;
            expect(frames[0]!.type).toBe(
                native ? "delegation.context.append" : "session.commentary.append",
            );
            const texts = frames.map((frame) =>
                typeof frame.content === "string" ? frame.content : frame.content[0]!.text,
            );
            expect(texts.every((text) => Buffer.byteLength(text) <= 500)).toBe(true);
            expect(texts.join("")).toBe("🙂".repeat(251));
            await transport.append({ delegationId: null, text: "quiet", speakable: false });
            expect(f.socket.sent.at(-1)).toMatchObject(
                native
                    ? { type: "session.context.append", channel: "commentary" }
                    : { type: "session.thinking.append", delegation_id: null },
            );
            transport.dispose();
        }
    });
    test("invalid intervals fail without fabricating transcript timing", async () => {
        const f = fixture();
        const transport = await f.start();
        f.ready();
        f.socket.event({
            type: "session.input_transcript.delta",
            delta: "bad",
            start_ms: 10,
            end_ms: 2,
        });
        expect(f.events.filter((event) => event.type === "transcript")).toHaveLength(0);
        expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
        transport.dispose();
    });
    test("no readiness acknowledgment ends startup and discards late events", async () => {
        vi.useFakeTimers();
        const f = fixture(true, { readyTimeoutMs: 5, closeTimeoutMs: 5 });
        await f.start();
        await vi.advanceTimersByTimeAsync(5);
        expect(f.socket.sent).toEqual([{ type: "session.close" }]);
        f.ready();
        f.socket.providerClose();
        expect(f.events).toHaveLength(1);
        expect(f.events[0]).toMatchObject({ type: "ended", orderly: false });
    });
    test("abort closes boundedly without retry", async () => {
        const f = fixture(true);
        await f.start();
        f.ready();
        f.controller.abort();
        f.socket.providerClose();
        expect(f.requests).toHaveLength(1);
        expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: true });
    });
    test("HTTP credential refusal is sanitized and never connects or retries", async () => {
        let calls = 0;
        const f = fixture(false, {
            fetch: async () => {
                calls++;
                return new Response("secret-sensitive upstream detail", { status: 403 });
            },
        });
        await expect(f.start()).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
            message: "The selected provider denied access to GPT-Live.",
        });
        expect(calls).toBe(1);
        expect(f.attachUrl()).toBe("");
    });
    test("HTTP 401 reports sign-in rejection after exactly one allocation attempt", async () => {
        const fetch = vi.fn(async () => new Response("private detail", { status: 401 }));
        const f = fixture(true, { fetch });
        await expect(f.start()).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
            message: "The selected sign-in expired or was rejected. Sign in to Codex again.",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(f.attachUrl()).toBe("");
    });
    test("queued input is snapshotted and operation count is bounded", async () => {
        const f = fixture(true);
        const transport = await f.start();
        f.ready();
        const input = { delegationId: null, text: "original", speakable: false };
        const first = transport.append(input);
        input.text = "mutated";
        await first;
        expect(f.socket.sent[0]).toMatchObject({ content: [{ text: "original" }] });
        transport.dispose();
        const f2 = fixture();
        const second = await f2.start();
        f2.ready();
        const pending = Array.from({ length: 128 }, () =>
            second.append({ delegationId: null, text: "x", speakable: false }),
        );
        await expect(
            second.append({ delegationId: null, text: "overflow", speakable: false }),
        ).rejects.toBeInstanceOf(LiveProviderError);
        await Promise.all(pending);
        second.dispose();
    });
    test("forbidden startup emits one safe failure and never ready", async () => {
        const f = fixture(true);
        const transport = await f.start();
        f.socket.event({
            type: "error",
            error: { code: "forbidden", message: "upstream private body" },
        });
        f.ready();
        expect(f.events).toEqual([
            {
                type: "ended",
                orderly: false,
                error: "The selected provider denied access to GPT-Live.",
                code: "forbidden",
            },
        ]);
        transport.dispose();
    });
    test("malformed terminal usage cannot finalize usage or cleanly end", async () => {
        const f = fixture();
        const transport = await f.start();
        f.ready();
        const closed = transport.close();
        f.socket.event({
            type: "session.closed",
            session: { id: "sess_test" },
            reason: "close_requested",
            usage: { seconds: -1 },
        });
        await closed;
        expect(f.events.some((event) => event.type === "usage")).toBe(false);
        expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
    });
    test("clean public termination drains once and repeated close is harmless", async () => {
        const f = fixture();
        const transport = await f.start();
        f.ready();
        const closed = transport.close();
        expect(f.socket.terminated).toBe(false);
        f.socket.event({
            type: "session.closed",
            session: { id: "sess_test" },
            reason: "close_requested",
            usage: { seconds: 5 },
        });
        await closed;
        await transport.close();
        f.socket.providerClose();
        expect(f.events.slice(-2)).toEqual([
            { type: "usage", seconds: 5, final: true },
            { type: "ended", orderly: true, error: null },
        ]);
    });
    test("native sends session.close then closes its socket and awaits the peer", async () => {
        const f = fixture(true);
        const transport = await f.start();
        f.ready();
        const closing = transport.close();
        await Promise.resolve();
        expect(f.socket.sent).toEqual([{ type: "session.close" }]);
        expect(f.socket.readyState).toBe(WebSocket.CLOSING);
        expect(f.events.filter((event) => event.type === "ended")).toEqual([]);
        f.socket.providerClose();
        await closing;
        expect(f.events.at(-1)).toEqual({ type: "ended", orderly: true, error: null });
    });
    test("unrequested public closure confirms usage but is never an orderly local end", async () => {
        for (const reason of ["expired", "remote_hangup", "close_requested"]) {
            const f = fixture();
            const transport = await f.start();
            f.ready();
            f.socket.event({
                type: "session.closed",
                session: { id: "sess_test" },
                reason,
                usage: { seconds: 5 },
            });
            expect(f.events.at(-2)).toEqual({ type: "usage", seconds: 5, final: true });
            expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
            transport.dispose();
        }
    });
    test("fractional public times preserve the fragment untimed without rounding", async () => {
        const f = fixture();
        const transport = await f.start();
        f.ready();
        f.socket.event({
            type: "session.input_transcript.delta",
            delta: "exact",
            start_ms: 12,
            end_ms: 15,
        });
        f.socket.event({
            type: "session.input_transcript.delta",
            delta: "fractional",
            start_ms: 12.4,
            end_ms: 15.6,
        });
        expect(f.events.slice(-2)).toEqual([
            { type: "transcript", role: "user", text: "exact", startMs: 12, endMs: 15 },
            { type: "transcript", role: "user", text: "fractional" },
        ]);
        expect(f.events.some((event) => event.type === "ended")).toBe(false);
        transport.dispose();
    });
    test("nonfinite, negative and unsafe transcript times are rejected", async () => {
        for (const start of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
            const f = fixture();
            const transport = await f.start();
            f.ready();
            f.socket.event({
                type: "session.input_transcript.delta",
                delta: "bad",
                start_ms: start,
                end_ms: start,
            });
            expect(f.events.at(-1)).toMatchObject({ type: "ended", orderly: false });
            transport.dispose();
        }
    });
    test("native transcript deduplication evicts old display keys without ending long calls", async () => {
        const f = fixture(true);
        const transport = await f.start();
        f.ready();
        for (let i = 0; i < 1000; i++)
            f.socket.event({
                type: "input_transcript.added",
                item: { type: "input_transcript", id: `item-${i}`, text: "x" },
            });
        f.socket.event({
            type: "input_transcript.added",
            item: { type: "input_transcript", id: "item-999", text: "x" },
        });
        expect(f.events.filter((event) => event.type === "transcript")).toHaveLength(1000);
        expect(f.events.some((event) => event.type === "ended")).toBe(false);
        transport.dispose();
    });
    test("close timeout fails without inventing final usage", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const transport = await f.start();
        f.ready();
        const closed = transport.close();
        await vi.advanceTimersByTimeAsync(20);
        await closed;
        expect(f.events.at(-1)).toMatchObject({
            type: "ended",
            orderly: false,
            error: "GPT-Live did not confirm closure before the deadline.",
        });
        expect(f.events.some((event) => event.type === "usage")).toBe(false);
    });
    test("HTTP setup and sideband attachment share one deadline", async () => {
        vi.useFakeTimers();
        const socket = new Socket();
        const f = fixture(false, {
            setupTimeoutMs: 30,
            fetch: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return Response.json({
                    session: { id: "sess_test" },
                    transport: { type: "webrtc", sdp: "v=answer\r\n" },
                });
            },
            connect: () => socket as unknown as WebSocket,
        });
        const rejected = expect(f.start()).rejects.toMatchObject({
            code: "live_unavailable",
            message: "GPT-Live connection setup exceeded its deadline.",
        });
        await vi.advanceTimersByTimeAsync(29);
        expect(socket.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(socket.terminated).toBe(true);
    });
});
