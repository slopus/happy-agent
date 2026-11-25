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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    LIVE_GREETING_CUE,
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
import type { TasksModule } from "../sources/tasks/index.js";
import type { TeamModule } from "../sources/team/index.js";
import type { UserInputModule } from "../sources/userInput/index.js";
import type { ProjectsModule } from "../sources/projects/index.js";
import type { WorkspacesModule } from "../sources/workspaces/index.js";
import { voiceClock, voiceTimeZone } from "../sources/live/impl/voiceTimes.js";
import { readCallHistory } from "../sources/live/persistence/liveCallHistory.js";
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
        forWorkspace: vi.fn(async () => undefined),
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
    const tasks = {
        listForMember: vi.fn(async () => []),
        forWorkspace: vi.fn(async () => undefined),
        onEvent,
    } as unknown as TasksModule;
    // Projects with their root conversations and workspaces, in sidebar order.
    const projectTree = {
        projects: [] as { id: string; name: string; agents: string[] }[],
        workspaces: [] as {
            id: string;
            name: string;
            projectId: string;
            parentId: string;
            agents: string[];
        }[],
    };
    const projects = {
        listCatalogPage: vi.fn(async () => ({
            projects: projectTree.projects.map(({ id, name }) => ({ id, name, status: "ready" })),
        })),
        listAgentIds: vi.fn(
            async (_ctx: unknown, id: string) =>
                projectTree.projects.find((project) => project.id === id)?.agents ?? [],
        ),
        onEvent,
    } as unknown as ProjectsModule;
    const workspaces = {
        listChildren: vi.fn(async (_ctx: unknown, projectId: string, parentId: string) =>
            projectTree.workspaces
                .filter((item) => item.projectId === projectId && item.parentId === parentId)
                .map(({ id, name }) => ({ id, name, status: "ready" })),
        ),
        listAgentIds: vi.fn(
            async (_ctx: unknown, id: string) =>
                projectTree.workspaces.find((workspace) => workspace.id === id)?.agents ?? [],
        ),
        onEvent,
    } as unknown as WorkspacesModule;
    const userInput = {
        list: vi.fn(async () => []),
        onEvent: vi.fn(() => () => undefined),
    } as unknown as UserInputModule;
    // Each conversation's public history, oldest first; tests add messages to it.
    const conversations = new Map<
        string,
        { role: "user" | "assistant" | "agent"; text: string; at: number }[]
    >();
    const history = {
        // Each conversation's latest run, taken here as its latest message.
        runActivity: vi.fn(
            async () =>
                new Map(
                    [...conversations].flatMap(([id, messages]) =>
                        messages.length === 0
                            ? []
                            : [
                                  [
                                      id,
                                      {
                                          at: Math.max(...messages.map((m) => m.at)),
                                          running: false,
                                      },
                                  ],
                              ],
                    ),
                ),
        ),
        read: vi.fn(async (_ctx: unknown, agentId: string, query: { limit: number }) => ({
            messages: (conversations.get(agentId) ?? []).slice(-query.limit).map((message) => ({
                message: {
                    role: message.role,
                    at: message.at,
                    blocks: [{ type: "text", text: message.text }],
                },
            })),
        })),
    } as unknown as HistoryModule;
    const working = new Set<string>();
    const titles = new Map<string, string>();
    const eventsModule = {
        activeRunId: vi.fn((agentId: string) => (working.has(agentId) ? "run" : undefined)),
    } as unknown as EventsModule;
    const team = { enabled: false } as unknown as TeamModule;
    const created = new Set<string>();
    const archived = new Set<string>();
    const subtasks = {
        create: vi.fn(async (_ctx: unknown, _parent: string, _input: unknown, agentId: string) => {
            created.add(agentId);
            return { agentId };
        }),
        isSubtask: vi.fn(() => false),
        sortSiblings: vi.fn(<T>(siblings: readonly T[]) => [...siblings]),
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
        history,
        eventsModule,
        team,
        userInput,
        projects,
        workspaces,
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
                    await emit(agentId, { type: "toolcall_start" } as SessionEvent);
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
            created.has(agentId) || conversations.has(agentId)
                ? {
                      metadata: {
                          ...(archived.has(agentId) ? { archivedAt: 1 } : {}),
                          ...(titles.has(agentId) ? { title: titles.get(agentId) } : {}),
                      },
                  }
                : undefined,
        ),
        childOf: vi.fn(async () => []),
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
        userInput,
        projects,
        workspaces,
        projectTree,
        history,
        conversations,
        titles,
        working,
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
        /** A new turn of the person's, after voice spoke: held context goes with its first words. */
        turn: (text: string) => {
            f.calls[index]!.onEvent({ type: "transcript", role: "assistant", text: "Mm-hm." });
            f.calls[index]!.onEvent({ type: "transcript", role: "user", text });
        },
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
const quietAppends = (f: Fixture) =>
    f.append.mock.calls.map(([input]) => input).filter((input) => !input.speakable);
/** What voice was asked to say about a request; the greeting cue is not one. */
const spoken = (f: Fixture) =>
    f.append.mock.calls
        .map(([input]) => input)
        .filter((input) => input.speakable && input.delegationId !== null);
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

    it("hands each request to Voice on the call's frozen route, as agent-originated, with only new speech and the call's context once", async () => {
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
            provenance: "Provider-derived speech and app context; not human authorization.",
            delegation: null,
            transcripts: [
                { transcriptId: expect.any(String), role: "user", text: "Open the release notes." },
            ],
            now: expect.any(String),
            personSaid: expect.any(Array),
            thisMachine: null,
            refs: { s1: "happy-agent" },
            context: f.calls[0]!.initialContext,
        });

        call.speak("And the garden notes.");
        call.delegate("second", "Open the garden notes");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(JSON.parse(f.sends[1]!.text)).toEqual({
            provenance: "Provider-derived speech and app context; not human authorization.",
            delegation: "Open the garden notes",
            transcripts: [
                { transcriptId: expect.any(String), role: "user", text: "And the garden notes." },
            ],
            now: expect.any(String),
            personSaid: expect.any(Array),
            thisMachine: null,
            refs: { s1: "happy-agent" },
        });
        // Once by this test for the fixture's route, and once by the call: never again per request.
        expect(f.config.liveControllerRoute).toHaveBeenCalledTimes(2);
    });

    it("gives Voice a call's first context once, then only what voice was told since", async () => {
        const f = await fixture();
        const call = await activeCall(f);
        call.speak("Hm.");
        call.delegate("first");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(JSON.parse(f.sends[0]!.text).context).toBe(f.calls[0]!.initialContext);
        f.outline.rows = [{ name: "Release notes", agentId: "release" }];
        f.emitSidebar();
        await expect.poll(() => quietAppends(f).length).toBe(1);
        call.delegate("second");
        await expect.poll(() => spoken(f).length).toBe(2);
        const second = JSON.parse(f.sends[1]!.text);
        expect(second).not.toHaveProperty("context");
        expect(second.updates).toEqual([quietAppends(f)[0]!.text]);
        expect(second.refs).toEqual({ s1: "happy-agent", s2: "release" });

        // The next call's context differs, so Voice is given it; an identical one is not resent.
        await f.live.close(f.db.context, "owner", "liveone");
        const next = await activeCall(f, request("livetwo", "window-two"));
        next.delegate("again");
        await expect.poll(() => spoken(f).length).toBe(3);
        expect(JSON.parse(f.sends[2]!.text).context).toBe(f.calls[1]!.initialContext);
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

    it("runs actions Voice calls across inferences before the fixed outcome", async () => {
        const f = await fixture();
        f.turns["two-opens"] = [
            { actions: [open({ kind: "session", ...releaseNotes })] },
            { actions: [open({ kind: "session", ...gardenNotes })] },
            { text: "Never spoken." },
        ];
        const call = await activeCall(f, voiceRequest(), succeeded);
        call.delegate("opens", "two-opens");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action.type)).toEqual([
            "desktopOpen",
            "desktopOpen",
        ]);
        expect(spoken(f)[0]!.text).toBe(later("Opened Release notes. Opened Garden notes."));
    });

    it("sends to a named conversation without changing the screen and says it was sent", async () => {
        const f = await fixture();
        f.turns["send-release"] = [
            {
                actions: [
                    { name: "sessionSend", args: { target: releaseNotes, text: "Ship it." } },
                ],
            },
            { text: "Never spoken." },
        ];
        f.turns["send-garden"] = [
            { actions: [{ name: "sessionSend", args: { target: gardenNotes, text: "Done." } }] },
            { text: "Never spoken." },
        ];
        // This desktop sends; one that can only stage answers `staged` and voice says so.
        let staging = false;
        const call = await activeCall(f, voiceRequest(), (frame) =>
            frame.action.type === "sessionSend"
                ? { status: "succeeded", output: { type: staging ? "staged" : "ack" } }
                : succeeded(frame),
        );
        call.delegate("release", "send-release");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action)).toEqual([
            { type: "sessionSend", target: releaseNotes, text: "Ship it." },
        ]);
        expect(spoken(f)[0]!.text).toBe(later("Sent to Release notes."));
        staging = true;
        call.delegate("garden", "send-garden");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(call.actions().map((frame) => frame.action.type)).toEqual([
            "sessionSend",
            "sessionSend",
        ]);
        expect(spoken(f)[1]!.text).toBe(
            later(
                "Staged the message in Garden notes. It has not been sent; the person must review it and press Send.",
            ),
        );
    });

    it("gives Voice every turn the person built a message from, until it is sent", async () => {
        const f = await fixture();
        f.turns["send-that"] = [
            {
                actions: [
                    { name: "sessionSend", args: { target: releaseNotes, text: "Built up." } },
                ],
            },
            { text: "Never spoken." },
        ];
        const call = await activeCall(f, voiceRequest(), (frame) =>
            frame.action.type === "sessionSend"
                ? { status: "succeeded", output: { type: "ack" } }
                : succeeded(frame),
        );
        call.speak(" I'm thinking the cache race");
        call.speak(" is the lock.");
        call.provider.onEvent({ type: "transcript", role: "assistant", text: "Mm-hm." });
        call.speak(" And, um, also check the eviction path.");
        call.provider.onEvent({ type: "transcript", role: "assistant", text: "Got it." });
        call.speak(" Okay, send that to the release notes task.");
        call.delegate("send", "send-that");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(JSON.parse(f.sends[0]!.text).personSaid).toEqual([
            "I'm thinking the cache race is the lock.",
            "And, um, also check the eviction path.",
            "Okay, send that to the release notes task.",
        ]);
        // What was sent is not offered again for the next message.
        call.speak(" Next thought.");
        call.delegate("again");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(JSON.parse(f.sends[1]!.text).personSaid).toEqual(["Next thought."]);
    });

    it("opens an off-screen draft before appending to it, and never appends when it cannot", async () => {
        const f = await fixture();
        f.turns["draft-release"] = [
            {
                actions: [
                    {
                        name: "composerDraftAppend",
                        args: { target: releaseNotes, text: "Ship it." },
                    },
                ],
            },
            { text: "Release notes could not be opened, so nothing was added." },
        ];
        let refuse = false;
        const call = await activeCall(f, voiceRequest(), (frame) =>
            refuse
                ? {
                      status: "refused",
                      code: "notFound",
                      message: "That conversation is no longer available.",
                  }
                : succeeded(frame),
        );
        call.delegate("release", "draft-release");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action.type)).toEqual([
            "desktopOpen",
            "composerDraftAppend",
        ]);
        expect(spoken(f)[0]!.text).toBe(
            later("Added the text to the draft in Release notes. Nothing was sent."),
        );
        refuse = true;
        call.delegate("again", "draft-release");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(spoken(f)[1]!.text).toBe(
            later("Release notes could not be opened, so nothing was added."),
        );
        expect(call.actions().map((frame) => frame.action.type)).toEqual([
            "desktopOpen",
            "composerDraftAppend",
            "desktopOpen",
        ]);
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
            "end_call",
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
            "end_call",
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

    it("gives a window without agent targets its own target for an agent it lists, and refuses others", async () => {
        const f = await fixture();
        const listed = { kind: "agent", connectionId: "local", agentId: "notes" };
        f.turns["open-listed"] = [
            {
                actions: [
                    open(listed),
                    { name: "sessionSend", args: { target: listed, text: "Ship it." } },
                ],
            },
            { text: "Never spoken." },
        ];
        f.turns["open-unlisted"] = [
            { actions: [open(agentTarget)] },
            { text: "That could not be opened." },
        ];
        const call = await activeCall(f, voiceRequest(), (frame) =>
            frame.action.type === "sessionSend"
                ? { status: "succeeded", output: { type: "ack" } }
                : succeeded(frame),
        );
        call.delegate("listed", "open-listed");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action)).toEqual([
            { type: "desktopOpen", target: { kind: "session", ...gardenNotes } },
            { type: "sessionSend", target: gardenNotes, text: "Ship it." },
        ]);
        expect(spoken(f)[0]!.text).toBe(later("Opened Garden notes. Sent to Garden notes."));
        call.delegate("unlisted", "open-unlisted");
        await expect.poll(() => spoken(f).length).toBe(2);
        expect(call.actions()).toHaveLength(2);
        expect(JSON.parse(f.toolResults.at(-1)!.text)).toMatchObject({
            status: "refused",
            message:
                "This window cannot open conversations by agent ID. Read desktopState and use its targets.",
        });
    });

    it("ends the call when the person asked, after voice's goodbye, without speaking an outcome", async () => {
        const f = await fixture();
        f.turns["hang-up"] = [
            { actions: [{ name: "end_call", args: {} }] },
            { text: "Ending the call." },
        ];
        const call = await activeCall(f);
        call.delegate("bye", "hang-up");
        await expect.poll(() => call.status(), { timeout: 4000 }).toBe("closed");
        expect(spoken(f)).toEqual([]);
        expect(f.append.mock.calls.map(([input]) => input.text)).toEqual([LIVE_GREETING_CUE]);
    });

    it("forgets a pending hang-up when the call ends first", async () => {
        const f = await fixture();
        f.turns["hang-up"] = [
            { actions: [{ name: "end_call", args: {} }] },
            { text: "Ending the call." },
        ];
        const call = await activeCall(f);
        const close = vi.spyOn(f.live, "close");
        call.delegate("bye", "hang-up");
        await expect
            .poll(() => f.records().some((record) => record.event === "delegation.delivered"))
            .toBe(true);
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => call.status()).toBe("closed");
        const closes = close.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 2300));
        expect(close.mock.calls.length).toBe(closes);
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

    it("accepts the desktop's own connection ID on its own, and agent targets only with it", async () => {
        const f = await fixture();
        f.turns["remote"] = [
            { actions: [open({ kind: "session", ...releaseNotes, connectionId: "remote" })] },
            { text: "That is on another server." },
        ];
        // A window that names this machine "remote" acts there, whatever an earlier window said.
        const call = await activeCall(
            f,
            { ...request(), desktopCapabilities: ["voiceFocus"], localConnectionId: "remote" },
            succeeded,
        );
        expect(call.frames[0]).toMatchObject({ type: "hello", capabilities: ["voiceFocus"] });
        call.delegate("remote", "remote");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(call.actions().map((frame) => frame.action.type)).toEqual(["desktopOpen"]);
        expect(JSON.parse(f.sends[0]!.text).thisMachine).toBe("remote");

        const other = await fixture();
        await other.start(voiceRequest([...allCapabilities, "agentTargets"]));
        const control = await other.attach();
        expect(control.frames[0]).toMatchObject({ type: "hello", capabilities: allCapabilities });
    });

    it("sends to a named agent's conversation as it is, and names it as the sidebar does", async () => {
        const f = await fixture();
        withRelease(f);
        f.turns["send-agent"] = [
            { actions: [{ name: "desktopState", args: {} }] },
            { actions: [{ name: "sessionSend", args: { target: agentTarget, text: "Ship it." } }] },
            { text: "Sent to Release notes." },
        ];
        const call = await activeCall(
            f,
            { ...voiceRequest([...allCapabilities, "agentTargets"]), localConnectionId: "local" },
            succeeded,
        );
        expect(call.frames[0]).toMatchObject({
            capabilities: [...allCapabilities, "agentTargets"],
        });
        call.delegate("agent", "send-agent");
        await expect.poll(() => spoken(f).length).toBe(1);
        expect(JSON.parse(f.toolResults[0]!.text)).toMatchObject({
            status: "succeeded",
            agentTargets: { connectionId: "local" },
        });
        expect(call.actions().map((frame) => frame.action)).toEqual([
            { type: "desktopState" },
            { type: "sessionSend", target: agentTarget, text: "Ship it." },
        ]);
        // The desktop's state read keeps the fixed outcome from applying, so Voice answers.
        expect(spoken(f)[0]!.text).toBe(later("Sent to Release notes."));
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

    it("starts voice with the phones' first context and the stored or built-in voice prompt", async () => {
        const f = await fixture();
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {
            system_prompt: "Speak like a lighthouse keeper.",
        };
        const asked = Date.now() - 5 * 60_000;
        const replied = Date.now() - 3 * 60_000;
        f.outline.rows = [
            { name: "Release notes", agentId: "release-agent" },
            { name: "Cache", agentId: "cache-agent" },
        ];
        f.conversations.set("happy-agent", [
            { role: "user", text: "What changed?", at: asked },
            { role: "assistant", text: "The cache race is fixed.", at: replied },
        ]);
        f.working.add("cache-agent");
        // A failed run and a pending question are visible without asking anyone.
        await f.hooks.afterAgentSettled?.(f.db.context, f.scope("release-agent"), {
            error: "Rate limited by the provider.",
        } as never);
        vi.mocked(f.userInput.list).mockImplementation(async (_ctx, agentId) =>
            agentId === "release-agent" ? ([{ question: "Which branch?" }] as never) : [],
        );
        const body = voiceRequest();
        body.context.activeTarget = {
            kind: "bot",
            connectionId: "local",
            groupId: "home",
            sessionId: "happy-agent",
            botId: "happy-bot",
        };
        await activeCall(f, body);
        expect(f.calls[0]!.instructions).toBe("Speak like a lighthouse keeper.");
        const context = f.calls[0]!.initialContext!;
        const now = context.match(/^Now: (\S+) \(the person's local time, UTC\)\n/)?.[1];
        expect(now).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d\+00:00$/);
        expect(context.slice(context.indexOf("\n") + 1)).toBe(
            [
                "focusRevision: 1",
                "",
                "On screen: Happy — bot, ref s1",
                "Working: no. Needs the person: no.",
                `Last message from the person: 5 minutes ago (${voiceClock(asked, "UTC")})`,
                `Last reply: 3 minutes ago (${voiceClock(replied, "UTC")})`,
                "Last turns, oldest first:",
                "1. The person (5 minutes ago): What changed?",
                "   Agent (3 minutes ago): The cache race is fixed.",
                "",
                "Conversations in the app, in the sidebar's order:",
                `- Happy — bot, ref s1, last active 3 minutes ago (${voiceClock(replied, "UTC").slice(11, 16)})`,
                "- Release notes — bot, ref s2, needs the person (asks: Which branch?), failed (Rate limited by the provider.)",
                "- Cache — bot, ref s3, working",
            ].join("\n"),
        );
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {};
        await activeCall(f, request("livetwo", "window-two"));
        expect(f.calls[1]!.instructions).toBe(LIVE_VOICE_INSTRUCTIONS);
    });

    it("starts a call without reading any conversation's history except the one on screen", async () => {
        const f = await fixture();
        f.outline.rows = Array.from({ length: 60 }, (_, index) => ({
            name: `Bot ${String(index)}`,
            agentId: `bot-agent-${String(index)}`,
        }));
        for (const { agentId } of f.outline.rows)
            f.conversations.set(agentId, [{ role: "assistant", text: "Done.", at: Date.now() }]);
        await activeCall(f);
        expect(f.history.read).not.toHaveBeenCalled();
        expect(f.history.runActivity).toHaveBeenCalledTimes(1);
        expect(f.calls[0]!.initialContext).toContain("- Bot 59 — bot, ref s");
    });

    it("reads every conversation's last run once, beside the directory, with one on screen", async () => {
        const f = await fixture();
        f.conversations.set("happy-agent", [{ role: "user", text: "Hi.", at: Date.now() }]);
        let directoryRead!: () => void;
        const gate = new Promise<void>((resolve) => (directoryRead = resolve));
        // The directory's first read waits until run activity has been asked for.
        vi.mocked(f.history.runActivity).mockImplementation(async () => {
            directoryRead();
            return new Map();
        });
        const catalog = vi.mocked(f.projects.listCatalogPage).getMockImplementation()!;
        vi.mocked(f.projects.listCatalogPage).mockImplementation(async (...args) => {
            await gate;
            return await catalog(...args);
        });
        const body = voiceRequest();
        body.context.activeTarget = {
            kind: "bot",
            connectionId: "local",
            groupId: "home",
            sessionId: "happy-agent",
            botId: "happy-bot",
        };
        await activeCall(f, body);
        expect(f.calls[0]!.initialContext).toContain("On screen: Happy — bot, ref s1");
        expect(f.history.runActivity).toHaveBeenCalledTimes(1);
    });

    it("never hands a model the whole sidebar: 100 listed, the rest found by paged search", async () => {
        const f = await fixture();
        f.outline.rows = Array.from({ length: 130 }, (_, index) => ({
            name: `Bot ${String(index).padStart(3, "0")}`,
            agentId: `many-${String(index)}`,
        }));
        // Six projects of 100 conversations, then the one asked for in the last project's
        // workspace: far past the first context, and past where the directory once stopped.
        f.projectTree.projects = Array.from({ length: 6 }, (_, project) => ({
            id: `p${String(project)}`,
            name: `Project ${String(project)}`,
            agents: Array.from(
                { length: 100 },
                (_, index) => `p${String(project)}-${String(index)}`,
            ),
        }));
        for (const { agents } of f.projectTree.projects)
            for (const id of agents) {
                f.titles.set(id, "Gym performance session");
                f.conversations.set(id, []);
            }
        f.projectTree.workspaces = [
            { id: "w", name: "Ledger work", projectId: "p5", parentId: "p5", agents: ["ledger"] },
        ];
        f.titles.set("ledger", "Lighthouse Ledger");
        // Never active, so recency never lifts it into the 100 listed.
        f.conversations.set("ledger", []);
        f.turns["search"] = [
            {
                actions: [
                    { name: "list_sidebar", args: {} },
                    { name: "list_sidebar", args: { cursor: "50" } },
                    { name: "list_sidebar", args: { query: "bot 12" } },
                    { name: "list_sidebar", args: { query: "Lighthouse Ledger" } },
                    { name: "read_conversations", args: { ids: ["ledger"] } },
                ],
            },
            { text: "Found it." },
        ];
        const call = await activeCall(f);
        const context = f.calls[0]!.initialContext!;
        expect(context.match(/^- .* — bot, ref /gmu)).toHaveLength(100);
        expect(context).toContain(
            "… and 632 more not listed; ask your backend to find one by name.",
        );
        call.delegate("search", "search");
        await expect.poll(() => spoken(f).length).toBe(1);
        // Voice is given references only for what voice was shown.
        expect(Object.keys(JSON.parse(f.sends[0]!.text).refs)).toHaveLength(100);
        const [first, second, found, far] = f.toolResults
            .slice(0, 4)
            .map((result) => JSON.parse(result.text));
        const read = f.toolResults[4]!.text;
        expect(first.rows).toHaveLength(50);
        expect(first).toMatchObject({ total: 732, nextCursor: "50" });
        expect(far).toEqual({
            rows: [
                expect.objectContaining({
                    agentId: "ledger",
                    title: "Lighthouse Ledger",
                    kind: "conversation",
                    parents: ["Project 5", "Ledger work"],
                }),
            ],
            total: 1,
        });
        expect(context).not.toContain("Lighthouse Ledger");
        expect(read).toContain("Lighthouse Ledger");
        expect(second.rows[0].title).toBe("Bot 049");
        expect(found.rows.map((row: { title: string }) => row.title)).toEqual(
            Array.from({ length: 10 }, (_, index) => `Bot 12${String(index)}`),
        );
        expect(found).not.toHaveProperty("nextCursor");
        expect(found.rows.at(-1)).toMatchObject({ agentId: "many-129", kind: "bot" });
    });

    it("counts a native call's voice prompt inside the startup budget", async () => {
        const f = await fixture();
        vi.mocked(f.config.liveCredential).mockResolvedValue({
            type: "codex_subscription",
            token: "fake",
        } as never);
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {
            system_prompt: "p".repeat(20_000),
        };
        f.outline.rows = Array.from({ length: 100 }, (_, index) => ({
            name: `Conversation ${String(index)} ${"x".repeat(60)}`,
            agentId: `wide-${String(index)}`,
        }));
        await activeCall(f);
        const context = f.calls[0]!.initialContext!;
        expect(Buffer.byteLength(context) + 20_000).toBeLessThanOrEqual(24 * 1024);
        expect(context).toContain("more not listed");
    });

    it("lists project and workspace conversations under their headings, with references", async () => {
        const f = await fixture();
        const at = Date.now() - 60_000;
        f.projectTree.projects = [{ id: "app", name: "App", agents: ["root-chat"] }];
        f.projectTree.workspaces = [
            {
                id: "feature",
                name: "Feature",
                projectId: "app",
                parentId: "app",
                agents: ["feature-chat"],
            },
            {
                id: "owned",
                name: "Bot's own",
                projectId: "app",
                parentId: "app",
                agents: ["hidden"],
            },
        ];
        vi.mocked(f.bots.forWorkspace).mockImplementation(async (_ctx, id) =>
            id === "owned" ? ({} as never) : undefined,
        );
        for (const [id, title] of [
            ["root-chat", "Root chat"],
            ["feature-chat", "Feature chat"],
            ["hidden", "Hidden"],
        ] as const) {
            f.titles.set(id, title);
            f.conversations.set(id, []);
        }
        f.conversations.set("feature-chat", [{ role: "assistant", text: "Done.", at }]);
        const call = await activeCall(f);
        call.speak("Hm.");
        const context = f.calls[0]!.initialContext!;
        expect(context).toContain(
            [
                "Conversations in the app, in the sidebar's order:",
                "- Happy — bot, ref s1",
                "- App — project",
                "  - Root chat — conversation, ref s2",
                "  - Feature — workspace",
                `    - Feature chat — conversation, ref s3, last active a minute ago (${voiceClock(at, voiceTimeZone(undefined)).slice(11, 16)})`,
            ].join("\n"),
        );
        expect(context).not.toContain("Hidden");

        // A conversation added to the workspace is told with its parents.
        f.titles.set("second-chat", "Second chat");
        f.conversations.set("second-chat", []);
        f.projectTree.workspaces[0]!.agents.push("second-chat");
        f.emitSidebar();
        await expect.poll(() => quiet(f).length, { timeout: 3000 }).toBe(1);
        expect(JSON.parse(quiet(f)[0]!.text)).toEqual({
            added: [
                {
                    kind: "conversation",
                    parents: ["App", "Feature"],
                    ref: "s4",
                    title: "Second chat",
                },
            ],
            event: "directory",
        });
    });

    it("tells voice only what changed in the directory, settled and after a pending outcome", async () => {
        const f = await fixture();
        let release!: () => void;
        f.turns["hold"] = [
            { gate: new Promise<void>((resolve) => (release = resolve)), text: "Done." },
        ];
        const call = await activeCall(f);
        call.speak("Hm.");
        f.emitSidebar();
        f.emitSidebar();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(quiet(f)).toEqual([]);

        f.outline.rows = [
            { name: "One", agentId: "one" },
            { name: "Two", agentId: "two" },
        ];
        f.emitSidebar();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        // Settled, but held until the person's next turn begins.
        expect(quiet(f)).toEqual([]);
        call.turn("And now?");
        await expect.poll(() => quiet(f).length, { timeout: 3000 }).toBe(1);
        expect(quiet(f)[0]).toEqual({
            delegationId: null,
            text: '{"added":[{"kind":"bot","ref":"s2","title":"One"},{"kind":"bot","ref":"s3","title":"Two"}],"event":"directory"}',
            speakable: false,
        });

        call.delegate("hold", "hold");
        await expect.poll(() => f.sends.length).toBe(1);
        f.outline.rows = [{ name: "Two, renamed", agentId: "two" }];
        f.emitSidebar();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(quiet(f)).toHaveLength(1);
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        call.turn("What changed?");
        await expect.poll(() => quiet(f).length).toBe(2);
        const order = f.append.mock.calls.map(([input]) => input.delegationId);
        // The greeting cue, the first change, the outcome, then the change it held.
        expect(order).toEqual([null, null, "hold", null]);
        expect(quiet(f)[1]!.text).toBe(
            '{"event":"directory","removed":["s2"],"renamed":[{"ref":"s3","title":"Two, renamed"}]}',
        );
    });

    it("records each push's kind and size, and its text only in the test capture file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "live-capture-"));
        const file = join(directory, "context.jsonl");
        vi.stubEnv("HAPPY_LIVE_CONTEXT_CAPTURE_FILE", file);
        try {
            const f = await fixture();
            f.turns["read"] = [{ text: "Release notes finished a minute ago." }];
            const call = await activeCall(f);
            call.speak("Hm.");
            f.outline.rows = [{ name: "Release notes", agentId: "notes" }];
            f.emitSidebar();
            await expect.poll(() => quiet(f).length, { timeout: 3000 }).toBe(1);
            call.delegate("read", "read");
            await expect.poll(() => f.append.mock.calls.length).toBe(3);
            const pushes = () => f.records().filter((record) => record.event === "context.pushed");
            await expect.poll(() => pushes().length).toBe(4);
            expect(pushes().map(({ kind, speakable }) => ({ kind, speakable }))).toEqual([
                { kind: "context", speakable: false },
                { kind: "greeting", speakable: true },
                { kind: "directory", speakable: false },
                { kind: "outcome", speakable: true },
            ]);
            expect(pushes()[2]).toMatchObject({
                appendCount: 1,
                bytes: Buffer.byteLength(quiet(f)[0]!.text),
            });
            // Building the startup context is timed apart from allocating the provider call.
            expect(f.records().find((record) => record.event === "context.built")).toMatchObject({
                bytes: Buffer.byteLength(f.calls[0]!.initialContext!),
                durationMs: expect.any(Number),
            });
            expect(JSON.stringify(f.records())).not.toContain("Release notes");
            const lines = (await readFile(file, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(lines.map(({ kind, text, speakable }) => ({ kind, text, speakable }))).toEqual([
                { kind: "context", text: f.calls[0]!.initialContext, speakable: false },
                { kind: "greeting", text: LIVE_GREETING_CUE, speakable: true },
                { kind: "directory", text: quiet(f)[0]!.text, speakable: false },
                { kind: "outcome", text: f.append.mock.calls[2]![0].text, speakable: true },
            ]);
            expect(lines.every(({ at }) => Number.isInteger(at))).toBe(true);
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("hears replies only from the four conversations most recently on screen", async () => {
        const f = await fixture();
        for (const id of ["one", "two", "three", "four", "five"]) f.conversations.set(id, []);
        const call = await activeCall(f, voiceRequest());
        call.speak("Hm.");
        for (const [index, id] of ["one", "two", "three", "four", "five"].entries())
            call.binding.message(
                JSON.stringify({
                    type: "desktopContext",
                    revision: index + 2,
                    context: {
                        ...voiceRequest().context,
                        activeTarget: {
                            kind: "session",
                            connectionId: "local",
                            groupId: "g",
                            sessionId: id,
                        },
                    },
                }),
            );
        await expect.poll(() => quietAppends(f).length).toBe(5);
        for (const id of ["one", "five"]) {
            await f.hooks.onEvent?.(f.db.context, f.scope(id), {
                type: "text_delta",
                delta: `Reply from ${id}.`,
            });
            await f.hooks.afterAgentSettled?.(f.db.context, f.scope(id), {} as never);
        }
        call.turn("Anything new?");
        await expect.poll(() => quietAppends(f).length).toBe(6);
        // "one" fell out of the four when "five" came on screen.
        expect(quietAppends(f)[5]!.text).toContain("Reply from five.");
        expect(JSON.stringify(quietAppends(f))).not.toContain("Reply from one.");
    });

    it("bounds a focus update to 16 KiB, letting the oldest turns give way", async () => {
        const f = await fixture();
        const long = "word ".repeat(1_600);
        f.conversations.set(
            "long-agent",
            Array.from({ length: 5 }, (_, index) => [
                { role: "user" as const, text: `Question ${String(index)} ${long}`, at: index },
                { role: "assistant" as const, text: `Answer ${String(index)} ${long}`, at: index },
            ]).flat(),
        );
        const call = await activeCall(f, voiceRequest());
        call.speak("Hm.");
        call.binding.message(
            JSON.stringify({
                type: "desktopContext",
                revision: 2,
                context: {
                    ...voiceRequest().context,
                    activeTarget: {
                        kind: "session",
                        connectionId: "local",
                        groupId: "g",
                        sessionId: "long-agent",
                    },
                },
            }),
        );
        await expect.poll(() => quietAppends(f).length).toBe(1);
        const text = quietAppends(f)[0]!.text;
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
        expect(text).toContain("Answer 4");
        expect(text).not.toContain("Question 0");
    });

    it("tells the focus with a conversation's unseen turns once, and its followed replies and errors", async () => {
        const f = await fixture();
        const at = Date.now() - 2 * 60_000;
        f.outline.rows = [{ name: "Release notes", agentId: "release-agent" }];
        f.conversations.set("release-agent", [
            { role: "user", text: "Cut the release.", at },
            { role: "assistant", text: "Tagged it.", at },
        ]);
        const call = await activeCall(f, voiceRequest());
        call.speak("Hm.");
        const focus = (revision: number, sessionId: string | null) =>
            call.binding.message(
                JSON.stringify({
                    type: "desktopContext",
                    revision,
                    context: {
                        ...voiceRequest().context,
                        activeTarget:
                            sessionId === null
                                ? null
                                : {
                                      kind: "session",
                                      connectionId: "local",
                                      groupId: "g",
                                      sessionId,
                                  },
                    },
                }),
            );
        focus(2, "release-agent");
        await expect.poll(() => quiet(f).length).toBe(1);
        const clock = voiceClock(at, "UTC");
        expect(JSON.parse(quiet(f)[0]!.text)).toEqual({
            event: "focus",
            focusRevision: 2,
            ref: "s2",
            title: "Release notes",
            working: false,
            needsPerson: false,
            turns: [
                {
                    person: { text: "Cut the release.", at: { ago: "2 minutes ago", at: clock } },
                    agent: { text: "Tagged it.", at: { ago: "2 minutes ago", at: clock } },
                },
            ],
        });
        focus(3, null);
        focus(4, "release-agent");
        await expect.poll(() => quiet(f).length).toBe(3);
        expect(JSON.parse(quiet(f)[1]!.text)).toEqual({
            event: "focus",
            focusRevision: 3,
            title: null,
        });
        expect(JSON.parse(quiet(f)[2]!.text)).not.toHaveProperty("turns");

        // Words before a step go when the step comes; the last words when the run settles.
        const emit = (event: SessionEvent) =>
            f.hooks.onEvent?.(f.db.context, f.scope("release-agent"), event);
        await emit({ type: "text_delta", delta: "Checking the changelog." });
        await emit({ type: "done", state: "tool_call", tokens });
        await emit({ type: "text_delta", delta: "Release 2.4 is out." });
        await f.hooks.afterAgentSettled?.(f.db.context, f.scope("release-agent"), {} as never);
        await f.hooks.afterAgentSettled?.(f.db.context, f.scope("release-agent"), {
            error: "The provider stopped.",
        } as never);
        await expect.poll(() => quiet(f).length).toBe(6);
        const lines = quiet(f)
            .slice(3)
            .map((input) => JSON.parse(input.text));
        expect(lines).toEqual([
            {
                at: { ago: "just now", at: expect.any(String) },
                event: "assistant_text",
                ref: "s2",
                text: "Checking the changelog.",
                title: "Release notes",
            },
            {
                at: { ago: "just now", at: expect.any(String) },
                event: "assistant_text",
                finishedTurn: true,
                ref: "s2",
                text: "Release 2.4 is out.",
                title: "Release notes",
            },
            {
                at: { ago: "just now", at: expect.any(String) },
                event: "session_error",
                reason: "The provider stopped.",
                ref: "s2",
                title: "Release notes",
            },
        ]);
        // A conversation nobody followed tells nothing.
        await f.hooks.onEvent?.(f.db.context, f.scope("happy-agent"), {
            type: "text_delta",
            delta: "Unrelated.",
        });
        await f.hooks.afterAgentSettled?.(f.db.context, f.scope("happy-agent"), {} as never);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(quiet(f)).toHaveLength(6);
    });

    it("carries what was said in the last call into the next call's recap", async () => {
        const f = await fixture();
        const call = await activeCall(f);
        // Whole native items carry no spacing of their own; the recap keeps the words apart.
        call.speak("Remember the word");
        call.speak("pineapple.");
        call.provider.onEvent({
            type: "transcript",
            role: "assistant",
            text: "Got it, pineapple.",
        });
        await expect
            .poll(() => call.frames.filter((frame) => frame.type === "transcript").length)
            .toBe(3);
        await f.live.close(f.db.context, "owner", "liveone");
        await expect.poll(() => call.status()).toBe("closed");
        await expect
            .poll(async () => (await readCallHistory(f.db.context, "owner")).length)
            .toBe(3);
        await activeCall(f, request("livetwo", "window-two"));
        expect(f.calls[1]!.initialContext).toContain(
            [
                "Previous voice conversation (earlier calls, oldest first):",
                "- just now, the person: Remember the word pineapple.",
                "- just now, you: Got it, pineapple.",
                "- just now: the person ended the call",
            ].join("\n"),
        );
    });

    it("never tells voice a reference it was not given, and introduces a conversation that starts work", async () => {
        const f = await fixture();
        f.outline.rows = Array.from({ length: 130 }, (_, index) => ({
            name: `Bot ${String(index).padStart(3, "0")}`,
            agentId: `many-${String(index)}`,
        }));
        const call = await activeCall(f);
        expect(f.calls[0]!.initialContext).not.toContain("Bot 129");
        // An unlisted conversation renamed or settled tells voice nothing.
        f.outline.rows[129]!.name = "Bot renamed";
        f.emitSidebar();
        await f.hooks.afterAgentSettled?.(f.db.context, f.scope("many-128"), {} as never);
        await new Promise((resolve) => setTimeout(resolve, 1300));
        call.speak("Anything new?");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(quietAppends(f)).toEqual([]);
        // A listed one that starts work is told by its reference; one that is not listed is named
        // in full, and voice holds its reference from then on.
        f.working.add("many-0");
        f.working.add("many-129");
        await f.hooks.beforeAgentLoop?.(f.db.context, f.scope("many-0"), {} as never);
        await f.hooks.beforeAgentLoop?.(f.db.context, f.scope("many-129"), {} as never);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        call.turn("What's working?");
        await expect.poll(() => quietAppends(f).length).toBe(1);
        const [listed, change] = JSON.parse(quietAppends(f)[0]!.text).changes;
        expect(listed).toEqual({
            needsPerson: false,
            ref: /Bot 000 — bot, ref (s\d+)/u.exec(f.calls[0]!.initialContext!)![1],
            title: "Bot 000",
            working: true,
        });
        expect(change).toMatchObject({ kind: "bot", title: "Bot renamed", working: true });
        // An unchanged status tells nothing again.
        await f.hooks.beforeAgentLoop?.(f.db.context, f.scope("many-0"), {} as never);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        call.turn("Anything else?");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(quietAppends(f)).toHaveLength(1);
        f.turns["which"] = [{ text: "Bot renamed is working." }];
        call.delegate("which", "which");
        await expect.poll(() => f.sends.length).toBe(1);
        expect(JSON.parse(f.sends[0]!.text).refs[change.ref]).toBe("many-129");
    });

    it("tells the desktop a stopping daemon ended the call, and remembers it as dropped", async () => {
        const f = await fixture();
        const call = await activeCall(f, { ...request(), desktopCapabilities: ["failureReasons"] });
        call.speak("Remember the word pineapple.");
        await expect
            .poll(() => call.frames.filter((frame) => frame.type === "transcript").length)
            .toBe(1);
        await f.live.stop();
        expect(call.frames.filter((frame) => frame.type === "status").at(-1)).toEqual({
            type: "status",
            status: "failed",
            error: "Voice ended because Happy Agent stopped. Start a new call once it is running again.",
            reason: "restart",
        });
        expect(await readCallHistory(f.db.context, "owner")).toEqual([
            expect.objectContaining({ kind: "person", text: "Remember the word pineapple." }),
            expect.objectContaining({
                kind: "ending",
                text: "the call dropped (Happy Agent stopped on the computer)",
            }),
        ]);
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
        // Only the greeting cue: nothing from AppState, context, or session updates.
        expect(f.append.mock.calls.map(([input]) => input.text)).toEqual([LIVE_GREETING_CUE]);
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
            const call = await activeCall(f);
            await expect.poll(() => f.append.mock.calls.length).toBe(1);
            f.append.mockRejectedValueOnce(new Error("Private socket diagnostic"));
            call.delegate("delivery");
            await expect.poll(() => call.status()).toBe("failed");
            // The greeting, then the one failed delivery, never a second attempt.
            expect(f.append).toHaveBeenCalledTimes(2);
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
            f.history,
            f.eventsModule,
            f.team,
            f.userInput,
            f.projects,
            f.workspaces,
        );
        const hooks = (await restored.beforeStart(
            f.db.context,
            f.agents as never,
        )) as AgentModuleHooks;
        expect(await readCallHistory(f.db.context, "owner")).toEqual([
            expect.objectContaining({
                kind: "ending",
                text: "the call dropped (Happy Agent restarted)",
            }),
        ]);
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

    it("tells a desktop that negotiated failure reasons why its call failed", async () => {
        for (const negotiated of [true, false]) {
            const f = await fixture();
            const call = await activeCall(f, {
                ...request(),
                desktopCapabilities: negotiated ? ["failureReasons"] : [],
            });
            call.provider.onEvent({
                type: "ended",
                orderly: false,
                error: "The selected sign-in expired or was rejected. Sign in to Codex again.",
                reason: "signIn",
            });
            await expect.poll(() => call.status()).toBe("failed");
            const failed = call.frames.filter(
                (frame) => frame.type === "status" && frame.status === "failed",
            );
            expect(failed).toEqual([
                {
                    type: "status",
                    status: "failed",
                    error: "The selected sign-in expired or was rejected. Sign in to Codex again.",
                    ...(negotiated ? { reason: "signIn" } : {}),
                },
            ]);
            expect(await f.live.get(f.db.context, "owner", "liveone")).toMatchObject({
                failureReason: "signIn",
            });
        }
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
            speed: "regular",
            speeds: ["regular"],
            notice: "Fast is not available for Sonnet 5 on this account, so voice uses Regular.",
        }));
        config.voiceAccounts = vi.fn(async () => [
            { providerId: "codex", credential: "codex_subscription", name: "Codex" },
        ]);
        const update = vi.fn(async (_ctx: unknown, _update: unknown) => true);
        config.updateRuntimeVoiceSettings = update;
        const changed = vi.fn();
        f.live.onSettingsUpdated(changed);
        expect(await f.live.voiceSettings()).toEqual({
            controller: {
                providerId: null,
                modelId: "anthropic/sonnet-5",
                effort: null,
                fastMode: true,
                speed: null,
            },
            effectiveController: {
                providerId: "claude",
                modelId: "anthropic/sonnet-5",
                effort: "low",
                serviceTier: null,
                speed: "regular",
                speeds: ["regular"],
                notice: "Fast is not available for Sonnet 5 on this account, so voice uses Regular.",
            },
            accounts: [{ providerId: "codex", credential: "codex_subscription", name: "Codex" }],
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
            systemPromptOverride: null,
            effectiveSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        await f.live.updateVoiceSettings(f.db.context, {
            controller: { providerId: null, fastMode: false, speed: "ultrafast" },
            systemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        expect(update).toHaveBeenLastCalledWith(expect.anything(), {
            controller_provider: null,
            controller_fast_mode: false,
            controller_speed: "ultrafast",
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
