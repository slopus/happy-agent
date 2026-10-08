import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import type {
    CreateLiveSessionRequest,
    LiveControlServerMessage,
} from "@slopus/happy-agent-client";
import type { SessionEvent } from "@slopus/happy-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule, VoiceCredentialPoolError } from "../sources/config/index.js";
import { DurableFunctionsModule } from "../sources/durableFunctions/index.js";
import { LiveModule } from "../sources/live/index.js";
import type { LiveProviderOptions } from "../sources/live/impl/liveProviderTransport.js";
import { moduleDatabase } from "./support/moduleDatabase.js";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../sources/live/impl/liveProviderTransport.js", () => ({
    createLiveProviderTransport: transport.create,
    LiveProviderError: class extends Error {},
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    transport.create.mockReset();
});

const request = (id = "liveone", windowId = "window-one"): CreateLiveSessionRequest => ({
    id,
    windowId,
    sdp: "v=fixture",
    credential: { type: "openai_api_key", providerId: "fixture" },
    contextRevision: 1,
    context: {
        windowId,
        connections: [],
        activeConnectionId: null,
        activeTarget: null,
        projects: [],
        workspaces: [],
        sessions: [],
        bots: [],
        activeSession: null,
        truncated: false,
    },
});

async function fixture(startDurable = true) {
    const inferenceRequests: unknown[] = [];
    const controllerLifetime = new AbortController();
    const provider = {
        session: vi.fn(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (_ctx: unknown, request: unknown): AsyncGenerator<SessionEvent> {
                inferenceRequests.push(request);
                yield { type: "text_delta", delta: "Ready." };
                yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
            },
        })),
    };
    const config = {
        liveControllerRoute: vi.fn(async () => ({
            provider,
            model: { id: "fixture", defaultEffort: "low" },
            signal: controllerLifetime.signal,
        })),
        liveCredential: vi.fn(async () => ({ type: "openai_api_key", token: "fake" })),
    } as unknown as ConfigModule;
    const durable = new DurableFunctionsModule();
    const live = new LiveModule(config, durable);
    const db = moduleDatabase([...durable.migrations, ...live.migrations], "live-test");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    const hooks = durable.beforeStart(db.context);
    await live.beforeStart(db.context);
    if (startDurable) await hooks.afterStart?.(db.context, {} as never);
    const calls: LiveProviderOptions[] = [];
    const append = vi.fn(async () => undefined);
    transport.create.mockImplementation(async (options: LiveProviderOptions) => {
        calls.push(options);
        return {
            sdp: "v=answer",
            append,
            close: async () => options.onEvent({ type: "ended", orderly: true, error: null }),
            dispose: vi.fn(),
        };
    });
    const events: unknown[] = [];
    live.onEvent((event) => events.push(event));
    cleanups.push(async () => {
        await live.stop();
        durable.stop();
        await Promise.resolve();
        db.close();
    });
    const start = async (body = request(), owner = "owner") => {
        const reserved = await live.reserve(db.context, owner, body);
        await expect(reserved.allocated).resolves.toBe("v=answer");
        return reserved.session.id;
    };
    const attach = async (id = "liveone", owner = "owner", window = "window-one") => {
        const frames: LiveControlServerMessage[] = [];
        const close = vi.fn();
        const prepared = await live.prepareControl(db.context, owner, id, window);
        const binding = prepared.attach({ send: (text) => frames.push(JSON.parse(text)), close });
        return { frames, binding, close };
    };
    return {
        live,
        db,
        durable,
        config,
        calls,
        events,
        start,
        attach,
        append,
        provider,
        inferenceRequests,
        controllerLifetime,
    };
}

describe("window-owned Live sessions", () => {
    it("explains a proven voice credential pool selection before allocating a call", async () => {
        const f = await fixture();
        vi.mocked(f.config.liveCredential).mockRejectedValueOnce(new VoiceCredentialPoolError());
        await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
            status: 503,
            code: "live_unavailable",
            message:
                "Select an individual OpenAI account for voice; account pools cannot supply voice credentials.",
        });
        expect(f.events).toEqual([]);
        expect(transport.create).not.toHaveBeenCalled();
    });

    it.each(["controller", "credential"])(
        "identifies the failing %s setup without exposing caught diagnostics or allocating a call",
        async (stage) => {
            const f = await fixture();
            const error = new Error("Sensitive provider diagnostic that must stay private.");
            if (stage === "controller")
                vi.mocked(f.config.liveControllerRoute).mockRejectedValueOnce(error);
            else vi.mocked(f.config.liveCredential).mockRejectedValueOnce(error);
            await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
                status: 503,
                code: "live_unavailable",
                message:
                    stage === "controller"
                        ? "Voice cannot use the default controller model. Check the enabled default model and its accounts."
                        : "Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",
            });
            expect(f.events).toEqual([]);
            expect(transport.create).not.toHaveBeenCalled();
        },
    );

    it("cancels controller work when its configured route is disabled without retrying", async () => {
        const f = await fixture();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        let release!: () => void;
        f.provider.session.mockImplementationOnce(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (ctx: unknown): AsyncGenerator<SessionEvent> {
                const signal = (ctx as { lifetime: AbortSignal }).lifetime;
                await new Promise<void>((resolve) => {
                    release = resolve;
                    signal.addEventListener("abort", () => resolve(), { once: true });
                    started();
                });
                yield { type: "done", state: "cancelled" };
            },
        }));
        await f.start();
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "disabled-route" });
        await running;
        try {
            f.controllerLifetime.abort();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("failed");
            expect(f.provider.session).toHaveBeenCalledTimes(1);
        } finally {
            release();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("failed");
        }
    });

    it("ends a claimed call immediately when its controller upgrade fails", async () => {
        const f = await fixture();
        await f.start();
        const prepared = await f.live.prepareControl(
            f.db.context,
            "owner",
            "liveone",
            "window-one",
        );
        prepared.failed();
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("failed");
        await expect(f.attach()).rejects.toMatchObject({ status: 409 });
    });
    it("keeps overlapping delegations active without starting a second controller", async () => {
        const f = await fixture();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        f.provider.session.mockImplementationOnce(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (): AsyncGenerator<SessionEvent> {
                await pending;
                yield { type: "text_delta", delta: "Done." };
                yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
            },
        }));
        await f.start();
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "first" });
        await expect.poll(() => f.provider.session.mock.calls.length).toBe(1);
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "overlap" });
        try {
            await expect.poll(() => f.append.mock.calls.length).toBe(1);
            expect(f.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    delegationId: "overlap",
                    text: expect.stringContaining("previous request"),
                }),
            );
            expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
            expect(f.provider.session).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
    });

    it("keeps streaming snapshots local and bounds status summaries even when appends are unavailable", async () => {
        const f = await fixture();
        const body = request();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        body.context.activeSession = {
            target,
            status: "running",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        };
        await f.start(body);
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        for (let i = 0; i < 100; i++) {
            control.binding.message(
                JSON.stringify({
                    type: "sessionUpdate",
                    target,
                    status: "running",
                    messages: [{ id: "stream", role: "assistant", text: "x".repeat(i + 1) }],
                    truncated: false,
                }),
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(f.append).not.toHaveBeenCalled();
        f.append.mockRejectedValueOnce(new Error("Append queue is full"));
        control.binding.message(
            JSON.stringify({
                type: "sessionUpdate",
                target,
                status: "idle",
                messages: [{ id: "stream", role: "assistant", text: "x".repeat(16000) }],
                truncated: false,
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(JSON.stringify(f.append.mock.calls[0]).length).toBeLessThan(2500);
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it.each([false, true])(
        "distinguishes unexpected controller loss from an already requested close (%s)",
        async (requested) => {
            const f = await fixture();
            await f.start();
            const control = await f.attach();
            f.calls[0]!.onEvent({ type: "ready" });
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("active");
            if (requested) await f.live.close(f.db.context, "owner", "liveone");
            control.binding.closed();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe(requested ? "closed" : "failed");
            if (!requested)
                expect((await f.live.get(f.db.context, "owner", "liveone")).error).toBe(
                    "The desktop controller disconnected.",
                );
        },
    );

    it("feeds fresh selected public snapshots to the controller without mutating accepted context revisions", async () => {
        const f = await fixture();
        const body = request();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        body.context.activeSession = {
            target,
            status: "running",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        };
        await f.start(body);
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        control.binding.message(
            JSON.stringify({
                type: "sessionUpdate",
                target,
                status: "idle",
                messages: [{ id: "message", role: "assistant", text: "Fresh public completion" }],
                truncated: false,
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        control.binding.message(
            JSON.stringify({ type: "desktopContext", revision: 1, context: body.context }),
        );
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "read-latest" });
        await expect.poll(() => f.inferenceRequests.length).toBe(1);
        expect(JSON.stringify(f.inferenceRequests[0])).toContain("Fresh public completion");
        expect((await f.live.get(f.db.context, "owner", "liveone")).contextRevision).toBe(1);
    });
    it("returns SDP before provider readiness and exposes only typed call-local transcript IDs", async () => {
        const f = await fixture();
        await f.start();
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("starting");
        const control = await f.attach();
        expect(control.frames.slice(0, 2)).toMatchObject([
            { type: "hello", windowId: "window-one", sessionId: "liveone", contextRevision: 1 },
            { type: "status", status: "starting" },
        ]);
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "transcript", role: "user", text: " the the " });
        await expect
            .poll(() => control.frames.filter((frame) => frame.type === "transcript"))
            .toHaveLength(1);
        expect(control.frames.at(-1)).toEqual({
            type: "transcript",
            role: "user",
            text: " the the ",
            transcriptId: expect.any(String),
        });
        expect(JSON.stringify(f.events)).not.toContain("v=fixture");
        expect(JSON.stringify(f.events)).not.toContain(" the the ");
    });

    it("isolates owners, duplicate IDs, one controller and one active call per window", async () => {
        const f = await fixture();
        await f.start();
        await expect(f.live.get(f.db.context, "other", "liveone")).rejects.toMatchObject({
            status: 404,
        });
        await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
            status: 409,
            session: { id: "liveone" },
        });
        await expect(f.live.reserve(f.db.context, "other", request())).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            f.live.reserve(f.db.context, "owner", request("livetwo")),
        ).rejects.toMatchObject({ status: 409 });
        await expect(f.attach("liveone", "owner", "foreign-window")).rejects.toMatchObject({
            status: 409,
        });
        await f.attach();
        await expect(f.attach()).rejects.toMatchObject({ status: 409 });
        expect(transport.create).toHaveBeenCalledTimes(1);
    });

    it("rolls reservation and events back with an outer transaction and never allocates", async () => {
        const f = await fixture();
        await expect(
            f.db.context.inTx(async (tx) => {
                await f.live.reserve(tx, "owner", request());
                expect(transport.create).not.toHaveBeenCalled();
                expect(f.events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        await expect(f.live.get(f.db.context, "owner", "liveone")).rejects.toMatchObject({
            status: 404,
        });
        expect(f.events).toEqual([]);
        expect(transport.create).not.toHaveBeenCalled();
    });

    it("rejects conflicting same-revision context and does not start controller inference", async () => {
        const f = await fixture();
        await f.start();
        const control = await f.attach();
        control.binding.message(
            JSON.stringify({
                type: "desktopContext",
                revision: 1,
                context: { ...request().context, truncated: true },
            }),
        );
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("failed");
        expect(f.provider.session).not.toHaveBeenCalled();
    });

    it("keeps native deliberate closure separate from confirmed usage and makes close idempotent", async () => {
        const f = await fixture();
        await f.start();
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        await f.live.close(f.db.context, "owner", "liveone");
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("closed");
        expect(await f.live.close(f.db.context, "owner", "liveone")).toMatchObject({
            status: "closed",
            usage: { seconds: null, final: false },
        });
    });

    it("marks unfinished calls failed after restart without replaying allocation", async () => {
        const f = await fixture(false);
        await f.live.reserve(f.db.context, "owner", request());
        const restored = new LiveModule(f.config, new DurableFunctionsModule());
        await restored.beforeStart(f.db.context);
        expect(await restored.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "failed",
            usage: { seconds: null, final: false },
        });
        expect(transport.create).not.toHaveBeenCalled();
    });
});
