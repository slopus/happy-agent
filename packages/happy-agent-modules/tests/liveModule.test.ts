import {
    DEFAULT_AGENT_PERMISSION_MODE,
    ensureAgentDatabaseConnection,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import type {
    CreateLiveSessionRequest,
    LiveAppState,
    LiveControlServerMessage,
} from "@slopus/happy-agent-client";
import type { SessionEvent } from "@slopus/happy-providers";
import { withLogger } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsModule } from "../sources/bots/index.js";
import {
    ConfigModule,
    VoiceCredentialPoolError,
    VoiceSettingsError,
} from "../sources/config/index.js";
import { DurableFunctionsModule } from "../sources/durableFunctions/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA } from "../sources/impl/messageOrigin.js";
import { LiveModule } from "../sources/live/index.js";
import {
    LIVE_LATER_REQUEST_INSTRUCTIONS,
    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
    LIVE_VOICE_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
    VOICE_AGENT_OPENING,
} from "../sources/live/impl/livePrompts.js";
import type {
    LiveProviderOptions,
    LiveProviderTransport,
} from "../sources/live/impl/liveProviderTransport.js";
import type { EventsModule } from "../sources/events/index.js";
import type { HistoryModule } from "../sources/history/index.js";
import type { SubtasksModule } from "../sources/subtasks/index.js";
import type { SurfacesModule } from "../sources/surfaces/index.js";
import type { TasksModule } from "../sources/tasks/index.js";
import type { TeamModule } from "../sources/team/index.js";
import { moduleDatabase } from "./support/moduleDatabase.js";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../sources/live/impl/liveProviderTransport.js", () => ({
    createLiveProviderTransport: transport.create,
    LiveProviderError: class extends Error {},
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.useRealTimers();
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

/** One inference of Voice's scripted turn. */
interface Round {
    actions?: { name: string; args: Record<string, unknown> }[];
    text?: string;
    error?: { kind: string; type?: string };
    /** The inference never finishes on its own; only an abort ends it. */
    stall?: true;
    gate?: Promise<void>;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ActionFrame = Extract<LiveControlServerMessage, { type: "actionRequested" }>;

/**
 * Live with collaborators that record what they are asked, and an agent system whose Voice runs a
 * scripted turn through Live's real hooks: acceptance, inferences, tool calls, and settlement. A
 * turn is chosen by a marker in the request message, so it never depends on call order.
 */
async function fixture(startDurable = true) {
    const controllerLifetime = new AbortController();
    const config = {
        liveControllerRoute: vi.fn(async () => ({
            provider: {},
            model: { providerId: "fixture", id: "fixture", defaultEffort: "low" },
            effort: "low",
            signal: controllerLifetime.signal,
        })),
        liveCredential: vi.fn(async () => ({ type: "openai_api_key", token: "fake" })),
        voiceSettings: {},
        voiceController: vi.fn(() => ({
            providerId: "fixture",
            modelId: "fixture",
            model: undefined,
            effort: "low",
            serviceTier: null,
            notice: null,
        })),
    } as unknown as ConfigModule;
    // The sidebar outline is Happy and the bots after it; tests add bots to change it.
    const outline = { rows: [] as { name: string; agentId: string }[] };
    const outlineListeners = new Set<() => void>();
    const onEvent = vi.fn((listener: () => void) => {
        outlineListeners.add(listener);
        return () => outlineListeners.delete(listener);
    });
    const happy = { id: "happy-bot", name: "Happy", agentId: "happy-agent", status: "active" };
    const bots = {
        forAgent: vi.fn(async () => undefined),
        chiefOfStaff: vi.fn(async () => happy),
        list: vi.fn(async () => [
            happy,
            ...outline.rows.map((row, index) => ({
                id: `bot-${String(index)}`,
                name: row.name,
                agentId: row.agentId,
                status: "active",
            })),
        ]),
        onEvent,
    } as unknown as BotsModule;
    const tasks = { listForMember: vi.fn(async () => []), onEvent } as unknown as TasksModule;
    const surfaces = { list: vi.fn(async () => []), onEvent } as unknown as SurfacesModule;
    const history = {} as unknown as HistoryModule;
    const eventsModule = {} as unknown as EventsModule;
    const team = { enabled: false } as unknown as TeamModule;
    const created = new Set<string>();
    const archived = new Set<string>();
    const subtasks = {
        create: vi.fn(async (_ctx: unknown, _parent: string, _input: unknown, agentId: string) => {
            created.add(agentId);
            return { agentId };
        }),
    } as unknown as SubtasksModule;
    const turns: Record<string, Round[]> = {};
    const sends: { agentId: string; text: string; options: Record<string, unknown> }[] = [];
    const toolResults: { name: string; text: string }[] = [];
    const running = new Map<string, AbortController>();
    const turnsEnded: Promise<void>[] = [];
    let hooks!: AgentModuleHooks;
    const durable = new DurableFunctionsModule();
    const live = new LiveModule(
        config,
        durable,
        bots,
        subtasks,
        tasks,
        surfaces,
        history,
        eventsModule,
        team,
    );
    const db = moduleDatabase([...durable.migrations, ...live.migrations], "live-test");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    const scope = (id: string) => ({ agent: { id, metadata: undefined } }) as never;
    const emit = (agentId: string, event: SessionEvent) =>
        hooks.onEvent?.(db.context, scope(agentId), event);
    const loop = async (agentId: string, messageId: string, text: string) => {
        const stop = new AbortController();
        running.set(agentId, stop);
        let error: string | undefined;
        try {
            await hooks.messageAccepted?.(db.context, scope(agentId), { id: messageId } as never);
            const marker = Object.keys(turns).find((key) => text.includes(key));
            for (const round of marker === undefined ? [{ text: "Ready." }] : turns[marker]!) {
                if (stop.signal.aborted) break;
                await hooks.beforeInference?.(db.context, scope(agentId), {} as never);
                if (stop.signal.aborted) break;
                await round.gate;
                if (round.stall) {
                    await new Promise<void>((resolve) => {
                        if (stop.signal.aborted) resolve();
                        stop.signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                    break;
                }
                if (round.error !== undefined) {
                    await emit(agentId, {
                        type: "done",
                        state: "error",
                        kind: round.error.kind,
                        message: "Codex could not use this account. Private detail.",
                        ...(round.error.type === undefined
                            ? {}
                            : { providerError: { type: round.error.type } }),
                    } as SessionEvent);
                    error = "Codex could not use this account. Private detail.";
                    break;
                }
                if (round.text !== undefined) {
                    await emit(agentId, { type: "text_start" });
                    await emit(agentId, { type: "text_delta", delta: round.text });
                    await emit(agentId, { type: "text_end" });
                    await emit(agentId, { type: "done", state: "normal", tokens });
                }
                if (round.actions !== undefined) {
                    const tools = await hooks.overrideTools!(db.context, scope(agentId), {
                        tools: [],
                    } as never);
                    await emit(agentId, { type: "done", state: "tool_call", tokens });
                    toolResults.push(
                        ...(await Promise.all(
                            round.actions.map(async ({ name, args }) => {
                                const tool = tools.find((candidate) => candidate.name === name);
                                if (tool === undefined) throw new Error(`Voice has no ${name}.`);
                                const result = (await tool.execute(
                                    db.context,
                                    args as never,
                                    {} as never,
                                )) as { text: string };
                                return { name, text: result.text };
                            }),
                        )),
                    );
                }
            }
        } finally {
            running.delete(agentId);
            await hooks.afterAgentSettled?.(db.context, scope(agentId), { error } as never);
        }
    };
    const agents = {
        config: vi.fn(async (_ctx: unknown, agentId: string) =>
            created.has(agentId)
                ? { metadata: archived.has(agentId) ? { archivedAt: 1 } : {} }
                : undefined,
        ),
        send: vi.fn(
            async (
                _ctx: unknown,
                agentId: string,
                message: { content: { text: string }[] },
                options: Record<string, unknown>,
            ) => {
                const text = message.content[0]!.text;
                sends.push({ agentId, text, options });
                // The loop consumes the message after the durable send has resolved.
                turnsEnded.push(
                    Promise.resolve().then(() => loop(agentId, options["id"] as string, text)),
                );
                return { id: options["id"] };
            },
        ),
        abort: vi.fn(async (_ctx: unknown, agentId: string) => {
            running.get(agentId)?.abort();
        }),
    };
    const durableHooks = durable.beforeStart(db.context);
    const info = vi.fn();
    const logged = withLogger(db.context, {
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info,
        trace: vi.fn(),
    });
    hooks = (await live.beforeStart(logged, agents as never)) as AgentModuleHooks;
    if (startDurable) await durableHooks.afterStart?.(db.context, {} as never);
    const calls: LiveProviderOptions[] = [];
    const append = vi.fn(
        async (_input: Parameters<LiveProviderTransport["append"]>[0]): Promise<void> => undefined,
    );
    transport.create.mockImplementation(async (options: LiveProviderOptions) => {
        calls.push(options);
        return {
            sdp: "v=answer",
            append,
            // The provider confirms closure later, from its own socket, as the real transport does.
            close: async () => {
                setImmediate(() => options.onEvent({ type: "ended", orderly: true, error: null }));
            },
            dispose: vi.fn(),
        };
    });
    const events: unknown[] = [];
    live.onEvent((event) => events.push(event));
    cleanups.push(async () => {
        await live.stop();
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.allSettled(turnsEnded);
        await new Promise((resolve) => setTimeout(resolve, 10));
        durable.stop();
        await Promise.resolve();
        db.close();
    });
    const start = async (body = request(), owner = "owner") => {
        const reserved = await live.reserve(db.context, owner, body);
        await expect(reserved.allocated).resolves.toBe("v=answer");
        return reserved.session.id;
    };
    /** Attach a desktop; `respond` answers each requested action it returns a result for. */
    const attach = async (
        id = "liveone",
        owner = "owner",
        window = "window-one",
        respond?: (frame: ActionFrame) => unknown,
    ) => {
        const frames: LiveControlServerMessage[] = [];
        const close = vi.fn();
        const prepared = await live.prepareControl(db.context, owner, id, window);
        const binding = prepared.attach({
            send: (text) => {
                const frame = JSON.parse(text) as LiveControlServerMessage;
                frames.push(frame);
                const result = frame.type === "actionRequested" ? respond?.(frame) : undefined;
                if (frame.type === "actionRequested" && result !== undefined)
                    queueMicrotask(() =>
                        binding.message(
                            JSON.stringify({
                                type: "actionResult",
                                actionId: frame.actionId,
                                result,
                            }),
                        ),
                    );
            },
            close,
        });
        return { frames, binding, close };
    };
    const records = () => info.mock.calls.map((args) => JSON.parse(args.at(-1)!));
    return {
        live,
        db,
        config,
        bots,
        subtasks,
        tasks,
        surfaces,
        history,
        eventsModule,
        team,
        agents,
        hooks,
        scope,
        outline,
        archived,
        emitSidebar: () => {
            for (const listener of outlineListeners) listener();
        },
        turns,
        sends,
        toolResults,
        calls,
        events,
        start,
        attach,
        append,
        controllerLifetime,
        info,
        records,
    };
}

const tokens = { input: 1, output: 1 };

/** A started, attached, active call, with helpers for its provider events and desktop. */
async function activeCall(
    f: Fixture,
    body = request(),
    respond?: (frame: ActionFrame) => unknown,
    owner = "owner",
) {
    await f.start(body, owner);
    const index = f.calls.length - 1;
    const control = await f.attach(body.id, owner, body.windowId, respond);
    f.calls[index]!.onEvent({ type: "ready" });
    await expect
        .poll(async () => (await f.live.get(f.db.context, owner, body.id!)).status)
        .toBe("active");
    return {
        ...control,
        provider: f.calls[index]!,
        speak: (text: string) =>
            f.calls[index]!.onEvent({ type: "transcript", role: "user", text }),
        delegate: (delegationId: string, text?: string) =>
            f.calls[index]!.onEvent({
                type: "delegation",
                delegationId,
                ...(text === undefined ? {} : { text }),
            }),
        actions: () =>
            control.frames.filter(
                (frame): frame is ActionFrame => frame.type === "actionRequested",
            ),
        answer: (action: ActionFrame, result: unknown) =>
            control.binding.message(
                JSON.stringify({ type: "actionResult", actionId: action.actionId, result }),
            ),
        status: async () => (await f.live.get(f.db.context, owner, body.id!)).status,
    };
}

const later = (text: string) => `${text}\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`;
const spoken = (f: Fixture) =>
    f.append.mock.calls.map(([input]) => input).filter((input) => input.speakable);
const voiceId = async (f: Fixture, owner = "owner") => {
    const id = await f.live.voiceAgent(f.db.context, owner);
    if (id === undefined) throw new Error("The person has no Voice.");
    return id;
};

const gardenNotes = { connectionId: "local", groupId: "garden", sessionId: "notes" };
const releaseNotes = { connectionId: "local", groupId: "garden", sessionId: "release" };
const allCapabilities = ["appState", "voiceFocus", "taskCreate", "sessionModelChange"];

function voiceState(focus = gardenNotes): LiveAppState {
    return {
        timeZone: "UTC",
        servers: [
            {
                connectionId: "local",
                name: "This Mac",
                kind: "local",
                online: true,
                catalog: "ready",
                bots: [],
                tasks: [],
                projects: [
                    {
                        target: {
                            kind: "project",
                            connectionId: "local",
                            projectId: "observatory",
                            groupId: "observatory",
                        },
                        name: "Observatory",
                        sessions: [],
                        workspaces: [
                            {
                                target: {
                                    kind: "workspace",
                                    connectionId: "local",
                                    projectId: "observatory",
                                    workspaceId: "garden",
                                    groupId: "garden",
                                },
                                name: "Garden",
                                status: "ready",
                                sessions: [
                                    {
                                        target: gardenNotes,
                                        title: "Garden notes",
                                        status: "idle",
                                        lastActivityAt: null,
                                    },
                                    {
                                        target: releaseNotes,
                                        title: "Release notes",
                                        status: "idle",
                                        lastActivityAt: null,
                                    },
                                ],
                            },
                        ],
                    },
                ],
                models: [],
            },
        ],
        focused: {
            target: { kind: "session", ...focus },
            title: null,
            latestMessage: {
                state: "loaded",
                role: "assistant",
                text: "The requested changes are complete.",
                truncated: false,
            },
        },
        truncated: false,
    };
}

const voiceRequest = (capabilities = allCapabilities): CreateLiveSessionRequest => {
    const body: CreateLiveSessionRequest = {
        ...request(),
        desktopCapabilities: capabilities,
        appState: voiceState(),
    };
    body.context.activeSession = {
        target: gardenNotes,
        status: "idle",
        messages: [],
        composerHasDraft: false,
        writeRefusal: null,
    };
    return body;
};
const open = (target: Record<string, unknown>) => ({ name: "desktopOpen", args: { target } });
const succeeded = (frame: ActionFrame) =>
    frame.action.type === "sessionSend"
        ? { status: "succeeded", output: { type: "staged" } }
        : frame.action.type === "desktopState"
          ? { status: "succeeded", output: { type: "context", context: request().context } }
          : { status: "succeeded", output: { type: "ack" } };

describe("the person's Voice", () => {
    it("creates one Voice per person as a subtask of Happy and keeps it across calls until archived", async () => {
        const f = await fixture();
        const first = await activeCall(f);
        const voice = await voiceId(f);
        expect(f.subtasks.create).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "happy-agent",
            {
                title: "Voice",
                text: VOICE_AGENT_OPENING,
                provider: "fixture",
                model: "fixture",
                effort: "low",
            },
            voice,
            undefined,
            { provider: "fixture", model: "fixture" },
            { unreported: true },
        );
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => first.status()).toBe("closed");

        await activeCall(f, request("livetwo", "window-two"));
        expect(await voiceId(f)).toBe(voice);
        expect(f.subtasks.create).toHaveBeenCalledOnce();

        await activeCall(f, request("liveother", "window-other"), undefined, "other");
        const others = await voiceId(f, "other");
        expect(others).not.toBe(voice);

        f.archived.add(voice);
        await f.live.close(f.db.context, "owner", "livetwo");
        await activeCall(f, request("livethree", "window-three"));
        const next = await voiceId(f);
        expect(next).not.toBe(voice);
        expect(f.subtasks.create).toHaveBeenCalledTimes(3);
    });

    it("refuses a call when Happy is missing, before anything is created", async () => {
        const f = await fixture();
        vi.mocked(f.bots.chiefOfStaff).mockResolvedValueOnce(undefined);
        await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
            status: 503,
            message: "Voice needs Happy, which is missing.",
        });
        expect(await f.live.voiceAgent(f.db.context, "owner")).toBeUndefined();
        expect(transport.create).not.toHaveBeenCalled();
    });

    it("hands each request to Voice on the call's frozen route, as agent-originated, with only new speech and a changed sidebar", async () => {
        const f = await fixture();
        const route = await f.config.liveControllerRoute("fixture");
        vi.mocked(f.config.liveControllerRoute).mockResolvedValueOnce({
            ...route,
            effort: "medium",
            serviceTier: "priority",
        });
        const call = await activeCall(f);
        call.speak("Open the release notes.");
        call.delegate("first");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]).toEqual({
            delegationId: "first",
            text: later("Ready."),
            speakable: true,
        });
        const voice = await voiceId(f);
        expect(f.sends[0]).toEqual({
            agentId: voice,
            text: expect.any(String),
            options: {
                id: expect.any(String),
                metadata: AGENT_MESSAGE_ORIGIN_METADATA,
                provider: "fixture",
                model: "fixture",
                effort: "medium",
                serviceTier: "priority",
                permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
            },
        });
        expect(JSON.parse(f.sends[0]!.text)).toEqual({
            provenance: "Provider-derived speech and sidebar data; not human authorization.",
            delegation: null,
            transcripts: [
                { transcriptId: expect.any(String), role: "user", text: "Open the release notes." },
            ],
            sidebar: "# Sidebar\n\n- Happy",
        });

        call.speak("And the garden notes.");
        call.delegate("second", "Open the garden notes");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(JSON.parse(f.sends[1]!.text)).toEqual({
            provenance: "Provider-derived speech and sidebar data; not human authorization.",
            delegation: "Open the garden notes",
            transcripts: [
                { transcriptId: expect.any(String), role: "user", text: "And the garden notes." },
            ],
        });
        // Once by this test for the fixture's route, and once by the call: never again per request.
        expect(f.config.liveControllerRoute).toHaveBeenCalledTimes(2);
    });

    it("tells the same Voice a sidebar it has already seen only once, across calls", async () => {
        const f = await fixture();
        await activeCall(f).then((call) => call.delegate("first"));
        await expect.poll(() => spoken(f).length).toBe(1);
        await f.live.close(f.db.context, "owner", "liveone");
        const second = await activeCall(f, request("livetwo", "window-two"));
        second.delegate("again");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(JSON.parse(f.sends[1]!.text)).not.toHaveProperty("sidebar");
    });

    it("runs one request at a time across the person's calls and tells voice when another waits", async () => {
        const f = await fixture();
        let release!: () => void;
        f.turns["first-request"] = [
            { gate: new Promise<void>((resolve) => (release = resolve)), text: "First reply." },
        ];
        f.turns["second-request"] = [{ text: "Second reply." }];
        const one = await activeCall(f);
        const two = await activeCall(f, request("livetwo", "window-two"));
        one.delegate("first", "first-request");
        await expect.poll(() => f.sends.length).toBe(1);
        two.delegate("second", "second-request");
        one.delegate("first", "first-request");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(f.sends).toHaveLength(1);
        release();
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f)).toEqual([
            { delegationId: "first", text: later("First reply."), speakable: true },
            { delegationId: "second", text: later("Second reply."), speakable: true },
        ]);
        expect(f.sends).toHaveLength(2);
    });

    it("tells voice an already queued request is coming when one call has two", async () => {
        const f = await fixture();
        let release!: () => void;
        f.turns["first-request"] = [
            { gate: new Promise<void>((resolve) => (release = resolve)), text: "First reply." },
        ];
        const call = await activeCall(f);
        call.delegate("first", "first-request");
        await expect.poll(() => f.sends.length).toBe(1);
        call.delegate("second");
        release();
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f).map((input) => input.text)).toEqual([
            `First reply.\n\n${LIVE_QUEUED_REQUEST_INSTRUCTIONS}`,
            later("Ready."),
        ]);
    });

    it("speaks verified terminal actions as the fixed outcome and nothing more from that turn", async () => {
        const f = await fixture();
        f.turns["open-release"] = [
            { actions: [open({ kind: "session", ...releaseNotes })] },
            { text: "I opened it. Anything else?" },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("open", "open-release");
        await expect.poll(() => f.toolResults.length).toBe(1);
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toBe(later("Opened Release notes."));
        await expect
            .poll(() => f.records().filter((record) => record.event === "controller.finished"))
            .toMatchObject([{ outcome: "fixed" }]);
        expect(spoken(f)).toHaveLength(1);
        await expect
            .poll(() =>
                call.frames.flatMap((frame) =>
                    frame.type === "voiceFocus" ? [[frame.target, frame.reason]] : [],
                ),
            )
            .toEqual([
                [{ kind: "session", ...releaseNotes }, "navigation"],
                [null, "mention"],
            ]);
    });

    it("opens an off-screen conversation before staging in it and stages the focused one directly", async () => {
        const f = await fixture();
        f.turns["stage-release"] = [
            {
                actions: [
                    { name: "sessionSend", args: { target: releaseNotes, text: "Ship it." } },
                ],
            },
            { text: "Never spoken." },
        ];
        f.turns["stage-garden"] = [
            { actions: [{ name: "sessionSend", args: { target: gardenNotes, text: "Done." } }] },
            { text: "Never spoken." },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("release", "stage-release");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action)).toEqual([
            { type: "desktopOpen", target: { kind: "session", ...releaseNotes } },
            { type: "sessionSend", target: releaseNotes, text: "Ship it." },
        ]);
        expect(spoken(f)[0]!.text).toBe(
            later(
                "Staged the message in Release notes. It has not been sent; the person must review it and press Send.",
            ),
        );
        call.delegate("garden", "stage-garden");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(
            call
                .actions()
                .slice(2)
                .map((frame) => frame.action.type),
        ).toEqual(["sessionSend"]);
    });

    it("never stages when the conversation cannot be opened, and speaks Voice's own account", async () => {
        const f = await fixture();
        f.turns["stage-release"] = [
            {
                actions: [
                    { name: "sessionSend", args: { target: releaseNotes, text: "Ship it." } },
                ],
            },
            { text: "Release notes could not be opened, so nothing was staged." },
        ];
        const call = await activeCall(f, voiceRequest(), () => ({
            status: "refused",
            code: "notFound",
            message: "That conversation is no longer available.",
        }));
        call.delegate("release", "stage-release");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toBe(
            later("Release notes could not be opened, so nothing was staged."),
        );
        expect(call.actions().map((frame) => frame.action.type)).toEqual(["desktopOpen"]);
        expect(f.toolResults[0]!.text).toContain("That conversation is no longer available.");
    });

    it("stops a batch after a refused action without starting the rest", async () => {
        const f = await fixture();
        f.turns["batch"] = [
            {
                actions: [
                    open({ kind: "session", ...releaseNotes }),
                    { name: "composerDraftAppend", args: { target: gardenNotes, text: "Later." } },
                ],
            },
            { text: "The release notes could not be opened." },
        ];
        const call = await activeCall(f, voiceRequest(), () => ({
            status: "refused",
            code: "notFound",
            message: "That conversation is no longer available.",
        }));
        call.delegate("batch", "batch");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions()).toHaveLength(1);
        expect(JSON.parse(f.toolResults[1]!.text)).toEqual({
            status: "refused",
            code: "failed",
            message: "This action was not started because an earlier action did not succeed.",
        });
        expect(spoken(f)[0]!.text).toBe(later("The release notes could not be opened."));
    });

    it.each([
        ["authentication", "unknown", "its account's sign-in was rejected", "sign in to"],
        ["out_of_tokens", "billing_error", "its account has run out of usage", "usage to reset"],
    ] as const)(
        "explains a Voice %s failure on the frozen account without rotating or replaying",
        async (type, kind, cause, remedy) => {
            const f = await fixture();
            f.turns["signed-out"] = [{ error: { kind, type } }];
            const call = await activeCall(f);
            expect(f.config.liveControllerRoute).toHaveBeenCalledWith("fixture");
            call.delegate("signed-out", "signed-out");
            await expect.poll(() => spoken(f).length).toBe(1);
            const text = spoken(f)[0]!.text;
            expect(text).toContain(cause);
            expect(text).toContain(remedy);
            expect(text).toContain("No action was started for this request.");
            expect(JSON.stringify(f.append.mock.calls)).not.toContain("Private detail");
            expect(JSON.stringify(f.info.mock.calls)).not.toContain("Private detail");
            expect(f.records()).toContainEqual(
                expect.objectContaining({
                    event: "controller.failed",
                    delegationId: "signed-out",
                    category: "inference",
                    detail: {
                        phase: "providerDone",
                        reason: "providerError",
                        round: 0,
                        providerErrorKind: kind,
                        providerErrorType: type,
                    },
                }),
            );
            expect(f.config.liveControllerRoute).toHaveBeenCalledOnce();
            expect(f.sends).toHaveLength(1);
            expect(await call.status()).toBe("active");
            call.delegate("followup");
            await expect.poll(() => spoken(f).length).toBe(2);
            expect(spoken(f)[1]!.text).toBe(later("Ready."));
        },
    );

    it("returns a safe explanation when Voice cannot take the request and accepts a follow-up", async () => {
        const f = await fixture();
        f.agents.send.mockRejectedValueOnce(new Error("Secret token and private transcript"));
        const call = await activeCall(f);
        call.delegate("failure");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toContain("could not complete");
        expect(spoken(f)[0]!.text).toContain("No action was started for this request.");
        expect(JSON.stringify(f.append.mock.calls)).not.toContain("Secret token");
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("Secret token");
        expect(f.records()).toContainEqual(
            expect.objectContaining({ event: "controller.failed", category: "inference" }),
        );
        expect(await call.status()).toBe("active");
        call.delegate("followup");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f)[1]!.text).toBe(later("Ready."));
        expect(transport.create).toHaveBeenCalledOnce();
    });

    it("stops Voice on the ninth inference of one request", async () => {
        const f = await fixture();
        f.turns["busy"] = Array.from({ length: 10 }, () => ({
            actions: [{ name: "desktopState", args: {} }],
        }));
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("busy", "busy");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toContain("within its limits");
        expect(call.actions()).toHaveLength(8);
        expect(f.agents.abort).toHaveBeenCalledWith(expect.anything(), await voiceId(f));
        expect(await call.status()).toBe("active");
    });

    it("stops a stalled Voice at the deadline, expires the queued request, and runs the next one", async () => {
        const f = await fixture();
        f.turns["stalled"] = [{ stall: true }];
        const call = await activeCall(f);
        vi.useFakeTimers();
        call.delegate("stalled", "stalled");
        call.delegate("expired");
        await vi.advanceTimersByTimeAsync(120_001);
        vi.useRealTimers();
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f)[0]!.text).toContain("before its deadline");
        expect(spoken(f)[0]!.text).toContain("No action was started for this request.");
        expect(spoken(f)[1]).toMatchObject({
            delegationId: "expired",
            text: expect.stringContaining("expired while waiting in the queue"),
        });
        expect(f.sends).toHaveLength(1);
        expect(f.agents.abort).toHaveBeenCalledWith(expect.anything(), await voiceId(f));
        call.delegate("next");
        await expect.poll(() => spoken(f).length).toBe(3);
        expect(spoken(f)[2]).toMatchObject({ delegationId: "next", text: later("Ready.") });
    });

    it("reports an uncertain desktop timeout, ignores its late result, and continues without replay", async () => {
        const f = await fixture();
        f.turns["read"] = [{ actions: [{ name: "desktopState", args: {} }] }, { text: "Unused." }];
        const call = await activeCall(f);
        vi.useFakeTimers();
        call.delegate("timeout", "read");
        for (let tick = 0; tick < 50 && call.actions().length === 0; tick++)
            await vi.advanceTimersByTimeAsync(1);
        expect(call.actions()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_001);
        vi.useRealTimers();
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toContain("did not return a confirmed outcome");
        expect(f.toolResults[0]!.text).toContain("Stop and do not retry it.");
        call.answer(call.actions()[0]!, { status: "succeeded", output: { type: "ack" } });
        call.delegate("after-timeout");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f)[1]!.text).toBe(later("Ready."));
        expect(call.actions()).toHaveLength(1);
        expect(await f.live.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "active",
            error: null,
        });
    });

    it("preserves uncertainty after a staged message followed by a Voice failure", async () => {
        const f = await fixture();
        f.turns["partial"] = [
            {
                actions: [
                    { name: "sessionSend", args: { target: gardenNotes, text: "Keep." } },
                    { name: "desktopState", args: {} },
                ],
            },
            { error: { kind: "unknown" } },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("partial", "partial");
        await expect.poll(() => spoken(f).length).toBe(1);
        const outcome = spoken(f)[0]!.text;
        expect(outcome).toContain("Some actions may already have completed");
        expect(outcome).not.toContain("No action was started");
        expect(outcome).not.toContain("Private detail");
    });

    it("fails the call when its controller account goes away, without retrying", async () => {
        const f = await fixture();
        f.turns["stalled"] = [{ stall: true }];
        const call = await activeCall(f);
        call.delegate("stalled", "stalled");
        await expect.poll(() => f.sends.length).toBe(1);
        f.controllerLifetime.abort();
        await expect.poll(() => call.status()).toBe("failed");
        expect((await f.live.get(f.db.context, "owner", "liveone")).error).toBe(
            "The configured desktop controller account is no longer available.",
        );
        expect(f.agents.abort).toHaveBeenCalledWith(expect.anything(), await voiceId(f));
        expect(f.sends).toHaveLength(1);
    });

    it("stops Voice's turn when the call closes and keeps Voice for the next call", async () => {
        const f = await fixture();
        f.turns["stalled"] = [{ stall: true }];
        const call = await activeCall(f);
        const voice = await voiceId(f);
        call.delegate("stalled", "stalled");
        await expect.poll(() => f.sends.length).toBe(1);
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => call.status()).toBe("closed");
        expect(f.agents.abort).toHaveBeenCalledWith(expect.anything(), voice);
        expect(spoken(f)).toEqual([]);
        await activeCall(f, request("livetwo", "window-two"));
        expect(await voiceId(f)).toBe(voice);
    });

    it("gives only Voice its fixed instructions and tool arrays, and refuses actions without a call", async () => {
        const f = await fixture();
        let release!: () => void;
        f.turns["hold"] = [
            { gate: new Promise<void>((resolve) => (release = resolve)), text: "Done." },
        ];
        const call = await activeCall(f, voiceRequest());
        const voice = await voiceId(f);
        const instructions = (id: string) =>
            f.hooks.overrideInstructions!(f.db.context, f.scope(id), {
                instructions: "Original instructions.",
            } as never);
        const tools = async (id: string) =>
            await f.hooks.overrideTools!(f.db.context, f.scope(id), {
                tools: [{ name: "kept" }],
            } as never);
        expect(await instructions(voice)).toBe(VOICE_AGENT_INSTRUCTIONS);
        expect(await instructions("someone-else")).toBe("Original instructions.");
        expect((await tools("someone-else")).map((tool) => tool.name)).toEqual(["kept"]);
        const idle = await tools(voice);
        expect(idle.map((tool) => tool.name)).toEqual([
            "list_sidebar",
            "read_conversations",
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "composerDraftAppend",
        ]);
        expect(
            JSON.parse(await f.live.runVoiceAction(f.db.context, voice, { type: "desktopState" })),
        ).toEqual({
            status: "refused",
            code: "failed",
            message: "No voice call is active for this request, so there is no window to act on.",
        });
        call.delegate("hold", "hold");
        await expect.poll(() => f.sends.length).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const busy = await tools(voice);
        expect(busy.map((tool) => tool.name)).toEqual([
            "list_sidebar",
            "read_conversations",
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "composerDraftAppend",
            "taskCreate",
            "sessionModelChange",
        ]);
        for (const tool of busy.slice(2)) {
            expect(tool.durable).toBe(false);
            expect(tool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
        }
        release();
        await expect.poll(() => spoken(f).length).toBe(1);
    });

    it("stops a Voice turn a restart resumed, and leaves other agents alone", async () => {
        const f = await fixture();
        await activeCall(f);
        const voice = await voiceId(f);
        await f.hooks.afterAgentActivatedTransact!(f.db.context, f.scope("someone-else"), {
            restored: true,
        });
        await f.hooks.beforeAgentLoop!(f.db.context, f.scope("someone-else"), {} as never);
        await f.hooks.afterAgentActivatedTransact!(f.db.context, f.scope(voice), {
            restored: false,
        });
        await f.hooks.beforeAgentLoop!(f.db.context, f.scope(voice), {} as never);
        expect(f.agents.abort).not.toHaveBeenCalled();
        await f.hooks.afterAgentActivatedTransact!(f.db.context, f.scope(voice), {
            restored: true,
        });
        await f.hooks.beforeAgentLoop!(f.db.context, f.scope(voice), {} as never);
        expect(f.agents.abort).toHaveBeenCalledExactlyOnceWith(expect.anything(), voice);
        await f.hooks.beforeAgentLoop!(f.db.context, f.scope(voice), {} as never);
        expect(f.agents.abort).toHaveBeenCalledOnce();
    });
});

describe("Voice's targets", () => {
    const agentTarget = { kind: "agent", connectionId: "local", agentId: "release-agent" };
    const withRelease = (f: Fixture) => {
        f.outline.rows = [{ name: "Release notes", agentId: "release-agent" }];
    };

    it("refuses an agent target in a window that cannot open one, without asking the desktop", async () => {
        const f = await fixture();
        f.turns["agent"] = [
            { actions: [open(agentTarget)] },
            { text: "That could not be opened." },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("agent", "agent");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions()).toEqual([]);
        expect(JSON.parse(f.toolResults[0]!.text)).toMatchObject({
            status: "refused",
            message:
                "This window cannot open conversations by agent ID. Read desktopState and use its targets.",
        });
    });

    it("refuses another server's conversation", async () => {
        const f = await fixture();
        f.turns["remote"] = [
            { actions: [open({ kind: "session", ...releaseNotes, connectionId: "remote" })] },
            { text: "That is on another server." },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("remote", "remote");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions()).toEqual([]);
        expect(JSON.parse(f.toolResults[0]!.text)).toEqual({
            status: "refused",
            code: "forbidden",
            message: "Voice acts only on this machine's conversations, not another server's.",
        });
    });

    it("accepts agent targets only with the desktop's own connection ID", async () => {
        const f = await fixture();
        await expect(
            f.live.reserve(f.db.context, "owner", {
                ...voiceRequest(),
                localConnectionId: "local",
            }),
        ).rejects.toMatchObject({ status: 400 });
        await f.start({ ...voiceRequest([...allCapabilities, "agentTargets"]) });
        const control = await f.attach();
        expect(control.frames[0]).toMatchObject({ type: "hello", capabilities: allCapabilities });
    });

    it("opens a named agent's conversation before staging in it and names it as the sidebar does", async () => {
        const f = await fixture();
        withRelease(f);
        f.turns["stage-agent"] = [
            { actions: [{ name: "desktopState", args: {} }] },
            { actions: [{ name: "sessionSend", args: { target: agentTarget, text: "Ship it." } }] },
            { text: "Staged it in Release notes for review." },
        ];
        const call = await activeCall(
            f,
            { ...voiceRequest([...allCapabilities, "agentTargets"]), localConnectionId: "local" },
            succeeded,
        );
        expect(call.frames[0]).toMatchObject({
            capabilities: [...allCapabilities, "agentTargets"],
        });
        call.delegate("agent", "stage-agent");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(JSON.parse(f.toolResults[0]!.text)).toMatchObject({
            status: "succeeded",
            agentTargets: { connectionId: "local" },
        });
        expect(call.actions().map((frame) => frame.action)).toEqual([
            { type: "desktopState" },
            { type: "desktopOpen", target: agentTarget },
            { type: "sessionSend", target: agentTarget, text: "Ship it." },
        ]);
        // The desktop's state read keeps the fixed outcome from applying, so Voice answers.
        expect(spoken(f)[0]!.text).toBe(later("Staged it in Release notes for review."));
    });

    it("speaks an agent target's sidebar name in the fixed outcome", async () => {
        const f = await fixture();
        withRelease(f);
        f.turns["open-agent"] = [{ actions: [open(agentTarget)] }, { text: "Never spoken." }];
        const call = await activeCall(
            f,
            { ...voiceRequest([...allCapabilities, "agentTargets"]), localConnectionId: "local" },
            succeeded,
        );
        call.delegate("agent", "open-agent");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]!.text).toBe(later("Opened Release notes."));
        // Focus names desktop entities only; the desktop resolves an agent itself.
        expect(call.frames.filter((frame) => frame.type === "voiceFocus")).toEqual([]);
    });
});

describe("what voice is told", () => {
    const quiet = (f: Fixture) =>
        f.append.mock.calls.map(([input]) => input).filter((input) => !input.speakable);

    it("starts voice with the sidebar outline and the stored or built-in voice prompt", async () => {
        const f = await fixture();
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {
            system_prompt: "Speak like a lighthouse keeper.",
        };
        await activeCall(f);
        expect(f.calls[0]!.instructions).toBe("Speak like a lighthouse keeper.");
        expect(f.calls[0]!.initialContext).toBe("# Sidebar\n\n- Happy");
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {};
        await activeCall(f, request("livetwo", "window-two"));
        expect(f.calls[1]!.instructions).toBe(LIVE_VOICE_INSTRUCTIONS);
    });

    it("tells voice the sidebar only when its outline text changes, after a pending outcome", async () => {
        const f = await fixture();
        let release!: () => void;
        f.turns["hold"] = [
            { gate: new Promise<void>((resolve) => (release = resolve)), text: "Done." },
        ];
        const call = await activeCall(f);
        f.emitSidebar();
        f.emitSidebar();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(quiet(f)).toEqual([]);

        f.outline.rows = [
            { name: "One", agentId: "one" },
            { name: "Two", agentId: "two" },
        ];
        f.emitSidebar();
        await expect.poll(() => quiet(f).length).toBe(1);
        expect(quiet(f)[0]).toEqual({
            delegationId: null,
            text: "# Sidebar\n\n- Happy\n- One\n- Two",
            speakable: false,
        });

        call.delegate("hold", "hold");
        await expect.poll(() => f.sends.length).toBe(1);
        f.outline.rows = [];
        f.emitSidebar();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(quiet(f)).toHaveLength(1);
        release();
        await expect.poll(() => quiet(f).length).toBe(2);
        const order = f.append.mock.calls.map(([input]) => input.delegationId);
        expect(order).toEqual([null, "hold", null]);
        expect(quiet(f)[1]!.text).toBe("# Sidebar\n\n- Happy");
    });

    it("never pushes AppState, context, or conversation updates to voice", async () => {
        const f = await fixture();
        const call = await activeCall(f, voiceRequest());
        call.binding.message(
            JSON.stringify({ type: "appState", appState: voiceState(releaseNotes) }),
        );
        call.binding.message(
            JSON.stringify({
                type: "desktopContext",
                revision: 2,
                context: voiceRequest().context,
            }),
        );
        call.binding.message(
            JSON.stringify({
                type: "sessionUpdate",
                target: gardenNotes,
                status: "running",
                messages: [],
                truncated: false,
            }),
        );
        await expect
            .poll(() => f.records().map((record) => record.event))
            .toContain("context.accepted");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(f.append).not.toHaveBeenCalled();
        expect(await call.status()).toBe("active");
    });

    it("bounds transcript diagnostic bursts and lifetime output while preserving every desktop fragment", async () => {
        const f = await fixture();
        const call = await activeCall(f);
        const transcripts = () => call.frames.filter((frame) => frame.type === "transcript");
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        for (let index = 0; index < 3; index++) call.speak("Private speech sentinel");
        await expect.poll(() => transcripts().length).toBe(3);
        expect(f.records().filter((record) => record.event === "transcript.received")).toHaveLength(
            1,
        );
        clock.mockImplementation(() => (now += 100));
        for (let index = 0; index < 1028; index++) {
            call.speak("Private speech sentinel");
            if ((index + 1) % 32 === 0 || index === 1027)
                await expect.poll(() => transcripts().length, { interval: 1 }).toBe(index + 4);
        }
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => call.status()).toBe("closed");
        expect(f.records().filter((record) => record.event === "transcript.received")).toHaveLength(
            1024,
        );
        expect(f.records().at(-1)).toMatchObject({
            event: "session.status",
            status: "closed",
            suppressed: 7,
        });
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("Private speech sentinel");
        clock.mockRestore();
    });

    it("keeps voice and Voice delivery working when every metadata log write throws", async () => {
        const f = await fixture();
        f.info.mockImplementation(() => {
            throw new Error("Private logger failure");
        });
        const call = await activeCall(f);
        call.delegate("logger-unavailable");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(spoken(f)[0]).toEqual({
            delegationId: "logger-unavailable",
            text: later("Ready."),
            speakable: true,
        });
        expect(call.close).not.toHaveBeenCalled();
        expect(await call.status()).toBe("active");
    });

    it.each([false, true])(
        "ends a lost response transport without attempting a second delivery (Voice error: %s)",
        async (voiceError) => {
            const f = await fixture();
            if (voiceError) f.agents.send.mockRejectedValueOnce(new Error("Private diagnostic"));
            f.append.mockRejectedValueOnce(new Error("Private socket diagnostic"));
            const call = await activeCall(f);
            call.delegate("delivery");
            await expect.poll(() => call.status()).toBe("failed");
            expect(f.append).toHaveBeenCalledOnce();
            expect(call.close).toHaveBeenCalledOnce();
            expect((await f.live.get(f.db.context, "owner", "liveone")).error).toContain(
                "could not deliver",
            );
        },
    );
});

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
                        ? "Voice cannot use the selected controller model. Check the voice settings and the selected account."
                        : "Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",
            });
            expect(f.events).toEqual([]);
            expect(transport.create).not.toHaveBeenCalled();
            expect(f.subtasks.create).not.toHaveBeenCalled();
        },
    );

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

    it("rolls the reservation, its Voice, and events back with an outer transaction and never allocates", async () => {
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
        expect(await f.live.voiceAgent(f.db.context, "owner")).toBeUndefined();
    });

    it("rejects conflicting same-revision context and never reaches Voice", async () => {
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
        expect(f.agents.send).not.toHaveBeenCalled();
    });

    it("keeps native deliberate closure separate from confirmed usage and makes close idempotent", async () => {
        const f = await fixture();
        const call = await activeCall(f);
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => call.status()).toBe("closed");
        expect(await f.live.close(f.db.context, "owner", "liveone")).toMatchObject({
            status: "closed",
            usage: { seconds: null, final: false },
        });
    });

    it("marks unfinished calls failed after restart without replaying allocation and still knows Voice", async () => {
        const f = await fixture(false);
        await f.live.reserve(f.db.context, "owner", request());
        const voice = await voiceId(f);
        const restored = new LiveModule(
            f.config,
            new DurableFunctionsModule(),
            f.bots,
            f.subtasks,
            f.tasks,
            f.surfaces,
            f.history,
            f.eventsModule,
            f.team,
        );
        const hooks = (await restored.beforeStart(
            f.db.context,
            f.agents as never,
        )) as AgentModuleHooks;
        expect(await restored.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "failed",
            usage: { seconds: null, final: false },
        });
        expect(transport.create).not.toHaveBeenCalled();
        expect(await restored.voiceAgent(f.db.context, "owner")).toBe(voice);
        expect(
            await hooks.overrideInstructions!(f.db.context, f.scope(voice), {
                instructions: "Original instructions.",
            } as never),
        ).toBe(VOICE_AGENT_INSTRUCTIONS);
        await restored.stop();
    });

    it("negotiates capabilities and echoes them in hello", async () => {
        const f = await fixture();
        await f.start({
            ...voiceRequest(),
            desktopCapabilities: [
                "voiceFocus",
                "appState",
                "laterIdea",
                "sessionModelChange",
                "taskCreate",
            ],
        });
        const control = await f.attach();
        expect(control.frames[0]).toEqual({
            type: "hello",
            sessionId: "liveone",
            windowId: "window-one",
            contextRevision: 1,
            capabilities: allCapabilities,
        });
    });

    it("keeps the original contract for desktops that negotiate nothing and refuses unnegotiated AppState", async () => {
        const f = await fixture();
        await expect(
            f.live.reserve(f.db.context, "owner", { ...request(), appState: voiceState() }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            f.live.reserve(f.db.context, "owner", {
                ...request(),
                desktopCapabilities: ["voiceFocus"],
                context: {
                    ...request().context,
                    activeTarget: {
                        kind: "task",
                        connectionId: "local",
                        groupId: "task-group",
                        sessionId: "task-session",
                        taskId: "task",
                    },
                },
            }),
        ).rejects.toMatchObject({ status: 400 });
        await f.start();
        const original = await f.attach();
        expect(original.frames[0]).not.toHaveProperty("capabilities");
        const call = await activeCall(f, {
            ...request("livetwo", "window-two"),
            desktopCapabilities: ["taskCreate", "sessionModelChange", "voiceFocus"],
        });
        expect(call.frames[0]).toMatchObject({ type: "hello", capabilities: ["voiceFocus"] });
        call.binding.message(JSON.stringify({ type: "appState", appState: voiceState() }));
        await expect.poll(() => call.status()).toBe("failed");
    });

    it("reports and changes voice settings through configuration and active-admin tools", async () => {
        const f = await fixture();
        const config = f.config as unknown as Record<string, unknown>;
        config.voiceSettings = {
            controller_model: "anthropic/sonnet-5",
            controller_fast_mode: true,
        };
        config.voiceController = vi.fn(() => ({
            providerId: "claude",
            modelId: "anthropic/sonnet-5",
            model: undefined,
            effort: "low",
            serviceTier: null,
            notice: "Fast mode is not available for Sonnet 5, so it is ignored.",
        }));
        const update = vi.fn(async (_ctx: unknown, _update: unknown) => true);
        config.updateRuntimeVoiceSettings = update;
        const changed = vi.fn();
        f.live.onSettingsUpdated(changed);
        expect(f.live.voiceSettings()).toEqual({
            controller: {
                providerId: null,
                modelId: "anthropic/sonnet-5",
                effort: null,
                fastMode: true,
            },
            effectiveController: {
                providerId: "claude",
                modelId: "anthropic/sonnet-5",
                effort: "low",
                serviceTier: null,
                notice: "Fast mode is not available for Sonnet 5, so it is ignored.",
            },
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
            systemPromptOverride: null,
            effectiveSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        await f.live.updateVoiceSettings(f.db.context, {
            controller: { providerId: null, fastMode: false },
            systemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        expect(update).toHaveBeenLastCalledWith(expect.anything(), {
            controller_provider: null,
            controller_fast_mode: false,
            system_prompt: null,
        });
        expect(changed).toHaveBeenCalledOnce();
        update.mockResolvedValueOnce(false);
        await f.live.updateVoiceSettings(f.db.context, { systemPrompt: "Be brief." });
        expect(update).toHaveBeenLastCalledWith(expect.anything(), { system_prompt: "Be brief." });
        expect(changed).toHaveBeenCalledOnce();
        await expect(
            f.live.updateVoiceSettings(f.db.context, { systemPrompt: "   " }),
        ).rejects.toBeInstanceOf(VoiceSettingsError);

        const scope = { agent: { id: "admin-agent" } } as never;
        expect(await f.hooks.tools!(f.db.context, scope)).toEqual([]);
        const forAgent = vi.mocked(f.bots.forAgent);
        forAgent.mockResolvedValue({ isAdmin: true, status: "active" } as never);
        const tools = await f.hooks.tools!(f.db.context, scope);
        expect(tools.map((tool) => tool.name)).toEqual([
            "get_voice_settings",
            "set_voice_settings",
        ]);
        const [get, set] = tools;
        expect(get!.requiresAutoOrFullAccess).toBeUndefined();
        expect(set!.requiresAutoOrFullAccess).toBe(true);
        await expect(get!.execute(f.db.context, {}, {} as never)).resolves.toMatchObject({
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        forAgent.mockResolvedValue({ isAdmin: true, status: "archived" } as never);
        await expect(
            set!.execute(f.db.context, { systemPrompt: "Be brief." }, {} as never),
        ).rejects.toThrow("Only an active admin bot can read or change voice settings.");
        expect(update).toHaveBeenCalledTimes(2);
    });
});
