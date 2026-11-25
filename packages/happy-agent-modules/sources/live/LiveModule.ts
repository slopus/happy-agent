import { appendFileSync } from "node:fs";
import { createId } from "@paralleldrive/cuid2";
import { createHash } from "node:crypto";
import {
    agentDatabase,
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import {
    LIVE_DESKTOP_CAPABILITIES,
    createLiveSessionRequestSchema,
    liveControlClientMessageSchema,
    liveControlServerMessageSchema,
    voiceConfigPatchSchema,
    type CreateLiveSessionRequest,
    type LiveActionSession,
    type LiveActionTarget,
    type LiveAppState,
    type LiveDesktopCapability,
    type LiveDesktopTarget,
    type VoiceConfig,
    type VoiceConfigPatch,
    type LiveSession,
    type LiveSessionUpdatedChanges,
    type LiveSessionCreatedPayload,
    type LiveSessionUpdatedPayload,
    type LiveControlClientMessage,
    type LiveControlServerMessage,
    type LiveDesktopAction,
    type LiveDesktopActionResult,
    type LiveDesktopContext,
    type LiveSessionRef,
} from "@slopus/happy-agent-client";
import type { SessionEvent, SessionProviderError } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncQueue, detach, shutdown, type Context } from "@steve.kite/stdlib";
import { BotsModule } from "../bots/index.js";
import {
    ConfigModule,
    VoiceCredentialPoolError,
    VoiceControllerRouteError,
    VoiceSettingsError,
    type VoiceSettingsUpdate,
} from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { EventsModule } from "../events/index.js";
import { HistoryModule } from "../history/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { SubtasksModule, type CreateSubtaskInput } from "../subtasks/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { UserInputModule } from "../userInput/index.js";
import { ProjectsModule } from "../projects/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { liveVersion } from "./impl/liveVersion.js";
import { LiveError } from "./LiveError.js";
import {
    activeLiveSessions,
    liveMigrations,
    liveSessionExists,
    pruneLiveSessions,
    readLiveSession,
    saveLiveSession,
} from "./persistence/liveSessions.js";
import {
    readVoiceAgent,
    saveOutlineSent,
    saveVoiceAgent,
    voiceAgents,
} from "./persistence/liveVoiceAgents.js";
import {
    LIVE_GREETING_CUE,
    LIVE_LATER_REQUEST_INSTRUCTIONS,
    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
    LIVE_VOICE_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
    VOICE_AGENT_OPENING,
} from "./impl/livePrompts.js";
import {
    liveDesktopTools,
    liveModelChangeTools,
    liveTaskCreateTools,
} from "./impl/liveDesktopTools.js";
import {
    liveAppStateEntities,
    liveAppStateView,
    liveControllerAppState,
    liveTargetKey,
} from "./impl/liveAppState.js";
import { liveFixedOutcome } from "./impl/liveOutcome.js";
import { liveMentionedTarget } from "./impl/liveMentionedTarget.js";
import { formatConversationReads } from "./impl/formatConversationReads.js";
import { readVoiceConversation } from "./impl/readVoiceConversation.js";
import {
    readVoiceDirectory,
    type VoiceDirectory,
    type VoiceDirectoryRow,
} from "./impl/readVoiceDirectory.js";
import { readVoiceTurns, VOICE_REPLY_BYTES, type VoiceTurns } from "./impl/readVoiceTurns.js";
import {
    cutWords,
    renderVoiceCallContext,
    sortedJson,
    VOICE_CONTEXT_BYTES,
    VOICE_DIRECTORY_ROWS,
    type VoiceRowState,
} from "./impl/renderVoiceCallContext.js";
import { voiceDirectoryUpdate } from "./impl/voiceDirectoryUpdate.js";
import { VoiceRefs } from "./impl/VoiceRefs.js";
import { voiceAgo, voiceClock, voiceTimeZone } from "./impl/voiceTimes.js";
import {
    appendCallHistory,
    readCallHistory,
    type VoiceCallSlot,
} from "./persistence/liveCallHistory.js";
import { voiceSidebarTools } from "./impl/voiceSidebarTools.js";
import { voiceCallTools } from "./impl/voiceCallTools.js";
import { getVoiceSettingsTool } from "./tools/get_voice_settings.js";
import { setVoiceSettingsTool } from "./tools/set_voice_settings.js";
import { LiveControllerError } from "./impl/LiveControllerError.js";
import {
    liveActionSummary,
    liveContextSummary,
    logLiveDiagnostic,
    type LiveControllerDetail,
    type LiveDiagnostic,
} from "./impl/liveDiagnostics.js";
import {
    createLiveProviderTransport,
    LiveProviderError,
    type LiveProviderEvent,
} from "./impl/liveProviderTransport.js";

const FRAME_BYTES = 256 * 1024;
const START = "live-start-once";
/** A request reaches Voice as one message of at most this size; older fragments give way. */
const REQUEST_MESSAGE_BYTES = 64 * 1024;
/** Voice's spoken outcome is clipped to this many characters. */
const OUTCOME_CHARACTERS = 8192;
/** How long a request may run in Voice, excluding queue time, and how many inferences. */
const REQUEST_DEADLINE_MS = 120_000;
const REQUEST_ROUNDS = 8;
/** One `read_conversations` answer stays cheap however many conversations it reads. */
const CONVERSATIONS_TEXT_LIMIT = 24_000;
/** A `list_sidebar` page: the phones' page of 50 within what one tool answer should carry. */
const VOICE_SIDEBAR_PAGE = 50;
const VOICE_SIDEBAR_BYTES = 24 * 1024;
/** One update line is at most this big, as the phones bound theirs. */
const VOICE_UPDATE_BYTES = 16 * 1024;
/** Background lines go only this soon after a person's turn begins: its first words are the cue. */
const PERSON_TURN_MS = 1_500;
/** How long voice's goodbye is given before a call the person asked to end is closed. */
const END_CALL_DELAY_MS = 2_000;
/** How long a stopped Voice turn is given to settle before the next request reaches Voice. */
const SETTLE_GRACE_MS = 10_000;
type Transport = Awaited<ReturnType<typeof createLiveProviderTransport>>;
type LiveContextKind =
    | "context"
    | "directory"
    | "focus"
    | "reply"
    | "error"
    | "outcome"
    | "greeting"
    | "status";
type Fragment = Extract<LiveControlServerMessage, { type: "transcript" }>;
export interface LiveControlSocket {
    send(text: string): void;
    close(code: number, reason: string): void;
}
export interface LiveControlBinding {
    message(text: string): void;
    closed(): void;
}
export type LiveEvent =
    | { ownerId: string; type: "live.session.created"; payload: LiveSessionCreatedPayload }
    | { ownerId: string; type: "live.session.updated"; payload: LiveSessionUpdatedPayload };
interface ActionState {
    delegationId: string;
    action: LiveDesktopAction;
    result?: LiveDesktopActionResult;
    expired?: true;
    pendingLogged?: true;
    lateLogged?: true;
    startedAt: number;
    resolve: (result: LiveDesktopActionResult) => void;
    timer: ReturnType<typeof setTimeout>;
}
interface Call {
    ownerId: string;
    session: LiveSession;
    context: LiveDesktopContext;
    request: CreateLiveSessionRequest;
    route: Awaited<ReturnType<ConfigModule["liveControllerRoute"]>>;
    credential: Awaited<ReturnType<ConfigModule["liveCredential"]>>;
    /** The person's Voice, which every request of this call is sent to. */
    voiceAgentId: string;
    abort: AbortController;
    controllerAbort: AbortController;
    allocated: ReturnType<typeof deferred<string>>;
    transport?: Transport;
    socket?: LiveControlSocket;
    claimed: boolean;
    controllerLost?: true;
    attachTimer?: ReturnType<typeof setTimeout>;
    queue: Promise<void>;
    /** Accepted desktop capabilities; empty for a desktop that negotiated none. */
    capabilities: LiveDesktopCapability[];
    /** The voice model prompt captured when the call started. */
    voiceInstructions: string;
    appState?: LiveAppState;
    /** The person's clock, as the desktop names it. */
    timeZone: string;
    /** The call's conversation references, the latest directory, and what voice was told of it. */
    refs: VoiceRefs;
    directory: VoiceDirectory;
    toldRows: readonly VoiceDirectoryRow[];
    /** The conversations voice was shown by reference; Voice is given only their agent IDs. */
    listed: Set<string>;
    /** The first context exactly as voice was told it. */
    contextText: string;
    /** Directory and status changes settle for a second from the first before they go. */
    directoryTimer?: ReturnType<typeof setTimeout>;
    statusTimer?: ReturnType<typeof setTimeout>;
    /** Ends the call after voice's goodbye, when the person asked to hang up. */
    endTimer?: ReturnType<typeof setTimeout>;
    /**
     * Background lines wait, in order, for the person's next turn and while a request lacks its
     * delivered outcome. Each is rendered when it goes, so its times are said as of then.
     */
    backlog: { kind: LiveContextKind; render: () => string }[];
    /** When the person last spoke; background lines go only while they are taking a turn. */
    personSpokeAt?: number;
    /** Each conversation's status as voice was last told it, and those that may have changed. */
    toldStatus: Map<string, string>;
    statusDirty: Set<string>;
    flushing?: true;
    /** Lines voice was told since Voice's last request, so Voice starts from the same context. */
    updates: string[];
    /** The conversation on screen, by agent ID, or null for none. */
    onScreen: string | null;
    /** The last four conversations on screen or messaged, newest first; their replies are told. */
    followed: string[];
    /** Each followed conversation's words since its last step, until they are complete. */
    pieces: Map<string, string>;
    /** The newest message time voice was told of each conversation, so nothing is replayed. */
    toldAt: Map<string, number>;
    /** What was said aloud in this call, for the next call's recap. */
    slots: VoiceCallSlot[];
    /**
     * What the person said in this call since voice last sent something, one entry per turn, so a
     * "send that" can carry everything they built up rather than voice's shortened delegation.
     */
    personTurns: string[];
    lastSpeaker?: "user" | "assistant";
    /** Accepted delegations without a delivered outcome. */
    requests: number;
    /** The target voice is currently highlighting, and why. */
    focus?: { key: string; reason: "mention" | "navigation" };
    queued: number;
    queuedBytes: number;
    fragments: Fragment[];
    /** Fragments Voice has already been given, so each request carries only new speech. */
    sentFragments: Set<string>;
    actions: Map<string, ActionState>;
    delegations: Set<string>;
    frequentDiagnostics: number;
    suppressedDiagnostics: number;
    diagnosticTimes: Map<string, number>;
}
/** One delegation while Voice works on it. */
interface Request {
    call: Call;
    delegationId: string;
    messageId: string;
    transcriptIds: string[];
    /** Voice consumed the message; only then are its turns this request's. */
    accepted: boolean;
    rounds: number;
    executed: { action: LiveDesktopAction; result: LiveDesktopActionResult; round: number }[];
    /** Desktop actions run one at a time, in the order Voice called them. */
    actions: Promise<unknown>;
    /** The text of Voice's inference in progress, and of its last completed one. */
    inferenceText: string;
    text: string;
    providerError?: {
        kind: NonNullable<LiveControllerDetail["providerErrorKind"]>;
        type?: SessionProviderError["type"];
    };
    failure?: LiveControllerError;
    /** The outcome already spoken; nothing more from this turn is. */
    delivered: boolean;
    /** A verified outcome waiting on whether Voice's current inference calls more actions. */
    pendingFixed?: string;
    /** Voice ended the call because the person asked; its outcome is not spoken. */
    endCall?: true;
    startedAt: number;
    settled: ReturnType<typeof deferred<string | undefined>>;
}

/**
 * One window-scoped feature owns its persistence, provider call and control socket, and each
 * person's Voice: a long-running subtask of Happy that every call of theirs hands requests to.
 */
export class LiveModule implements AgentModule {
    readonly name = "live";
    readonly migrations = liveMigrations;
    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #bots: BotsModule;
    readonly #subtasks: SubtasksModule;
    readonly #tasks: TasksModule;
    readonly #userInput: UserInputModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #history: HistoryModule;
    readonly #events: EventsModule;
    readonly #team: TeamModule;
    readonly #calls = new Map<string, Call>();
    readonly #listeners = new Set<(event: LiveEvent) => void>();
    readonly #settingsListeners = new Set<() => void>();
    /** Each Voice's owner, by Voice's agent ID, as stored. */
    readonly #voiceOwners = new Map<string, string>();
    /** One first-in, first-out queue per person, across all of their calls. */
    readonly #voiceQueues = new Map<string, ReturnType<typeof asyncQueue>>();
    /** The request each Voice is working on, by Voice's agent ID. */
    readonly #requests = new Map<string, Request>();
    /** Recap writes in flight; shutdown waits for them so a dropped call is remembered. */
    readonly #recapWrites = new Set<Promise<unknown>>();
    /** Why each conversation's last run failed, seen since the daemon started; cleared on success. */
    readonly #failures = new Map<string, string>();
    /** Voice turns a restart interrupted; they are stopped, never resumed. */
    readonly #interrupted = new Set<string>();
    #agents: AgentSystemRef | undefined;
    #unsubscribe: (() => void)[] = [];
    #ctx: Context | undefined;
    #stopped = false;

    constructor(
        config: ConfigModule,
        durable: DurableFunctionsModule,
        bots: BotsModule,
        subtasks: SubtasksModule,
        tasks: TasksModule,
        history: HistoryModule,
        events: EventsModule,
        team: TeamModule,
        userInput: UserInputModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
    ) {
        this.#config = config;
        this.#durable = durable;
        this.#bots = bots;
        this.#subtasks = subtasks;
        this.#tasks = tasks;
        this.#userInput = userInput;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#history = history;
        this.#events = events;
        this.#team = team;
        durable.register({
            name: START,
            argumentsSchema: Type.Object({ id: Type.String() }, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx, execution) => {
                const call = this.#calls.get(execution.arguments.id);
                // SDP and credential intent is process-private. A restarted invocation must never allocate.
                if (call === undefined) return null;
                const attempted = await execution.kv.read(ctx, "attempted");
                if (attempted !== undefined) {
                    await this.#fail(call, "Voice startup was interrupted and was not retried.");
                    return null;
                }
                await execution.kv.write(ctx, "attempted", true);
                await this.#start(call);
                return null;
            },
        });
    }

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Voice requires the agent database.");
        this.#agents = agents;
        this.#ctx = withAgentDatabase(detach(ctx).named("live-sessions"), database);
        shutdown.get(ctx)?.register("live", async () => await this.stop());
        await ctx.inTx(async (tx) => {
            for (const { ownerId, session } of await activeLiveSessions(tx)) {
                await this.#update(tx, ownerId, session, {
                    status: "failed",
                    error: "Voice ended because the daemon restarted. Start a new call explicitly.",
                    failureReason: "restart",
                    endedAt: Date.now(),
                    usage: { seconds: session.usage.seconds, final: false },
                });
                // What was said in it died with the process; that it dropped is still known.
                await appendCallHistory(
                    tx,
                    ownerId,
                    [
                        {
                            at: session.updatedAt,
                            kind: "ending",
                            text: "the call dropped (Happy Agent restarted)",
                        },
                    ],
                    Date.now(),
                );
            }
            for (const voice of await voiceAgents(tx))
                this.#voiceOwners.set(voice.agentId, voice.ownerId);
        });
        // Any bot, task, or subtask change may rename, add, move, or remove a conversation; an
        // unchanged directory tells voice nothing.
        const directoryChanged = () => {
            for (const call of this.#calls.values()) this.#queueDirectory(call);
        };
        this.#unsubscribe = [
            this.#bots.onEvent(directoryChanged),
            this.#tasks.onEvent(directoryChanged),
            this.#projects.onEvent(directoryChanged),
            this.#workspaces.onEvent(directoryChanged),
            this.#userInput.onEvent((_ctx, event) =>
                this.#statusChanged(event.request.askingAgentId),
            ),
        ];
        return {
            tools: async (toolCtx, scope) =>
                (await this.#isAdmin(toolCtx, scope.agent.id))
                    ? [
                          getVoiceSettingsTool(this, scope.agent.id),
                          setVoiceSettingsTool(this, scope.agent.id),
                      ]
                    : [],
            overrideInstructions: (_hookCtx, scope, input) =>
                this.#voiceOwners.has(scope.agent.id)
                    ? VOICE_AGENT_INSTRUCTIONS
                    : input.instructions,
            // Voice is one job with fixed arrays: the sidebar's read tools and the call's desktop.
            overrideTools: (_hookCtx, scope, input) => {
                const owner = this.#voiceOwners.get(scope.agent.id);
                return owner === undefined ? input.tools : this.#voiceTools(owner, scope.agent.id);
            },
            afterAgentActivatedTransact: (_hookCtx, scope, activation) => {
                if (activation.restored && this.#voiceOwners.has(scope.agent.id))
                    this.#interrupted.add(scope.agent.id);
                // A new subtask is a new conversation in the directory.
                if (!activation.restored) directoryChanged();
            },
            metadataChanged: () => directoryChanged(),
            beforeAgentLoop: async (hookCtx, scope) => {
                this.#statusChanged(scope.agent.id);
                if (!this.#interrupted.delete(scope.agent.id)) return;
                await this.#requireAgents().abort(hookCtx, scope.agent.id);
            },
            messageAccepted: (_hookCtx, scope, accepted) => {
                const request = this.#requests.get(scope.agent.id);
                if (request?.messageId === accepted.id) request.accepted = true;
            },
            beforeInference: (hookCtx, scope) => {
                const request = this.#requests.get(scope.agent.id);
                if (request === undefined || !request.accepted) return;
                request.inferenceText = "";
                if (request.delivered || request.failure !== undefined) return;
                // Actions that all succeeded and ended in a terminal one are the outcome, unless
                // this inference goes on to more actions: its first output decides.
                const fixed = this.#fixedOutcome(request);
                if (fixed === undefined) delete request.pendingFixed;
                else request.pendingFixed = fixed;
                if (++request.rounds > REQUEST_ROUNDS) {
                    request.failure = new LiveControllerError("limit", {
                        phase: "desktopAction",
                        reason: "actionLimit",
                        round: REQUEST_ROUNDS,
                    });
                    void this.#requireAgents()
                        .abort(hookCtx, scope.agent.id)
                        .catch(() => undefined);
                }
            },
            onEvent: (_hookCtx, scope, event) => {
                this.#followedEvent(scope.agent.id, event);
                const request = this.#requests.get(scope.agent.id);
                if (request === undefined || !request.accepted) return;
                if (request.pendingFixed !== undefined) {
                    if (
                        event.type === "toolcall_start" ||
                        (event.type === "done" && event.state === "tool_call")
                    )
                        delete request.pendingFixed;
                    else if (
                        event.type === "text_start" ||
                        event.type === "text_delta" ||
                        event.type === "done"
                    )
                        void this.#deliver(request, request.pendingFixed, "fixed");
                }
                if (event.type === "text_delta") {
                    if (request.inferenceText.length < OUTCOME_CHARACTERS)
                        request.inferenceText += event.delta;
                } else if (event.type === "done" && event.state === "normal") {
                    if (request.inferenceText.trim() !== "")
                        request.text = request.inferenceText.trim().slice(0, OUTCOME_CHARACTERS);
                } else if (event.type === "done" && event.state === "error") {
                    request.providerError = {
                        kind: event.kind,
                        ...(event.providerError === undefined
                            ? {}
                            : { type: event.providerError.type }),
                    };
                }
            },
            afterAgentSettled: (_hookCtx, scope, settlement) => {
                this.#failures.delete(scope.agent.id);
                if (settlement.error !== undefined) {
                    if (this.#failures.size >= 1000)
                        this.#failures.delete(this.#failures.keys().next().value!);
                    this.#failures.set(scope.agent.id, settlement.error);
                }
                this.#followedSettled(scope.agent.id, settlement.error);
                this.#statusChanged(scope.agent.id);
                const request = this.#requests.get(scope.agent.id);
                if (request?.accepted === true) request.settled.resolve(settlement.error);
            },
        };
    };

    onEvent(listener: (event: LiveEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** The additive desktop capabilities this daemon accepts in a creation request. */
    get desktopCapabilities(): readonly LiveDesktopCapability[] {
        return LIVE_DESKTOP_CAPABILITIES;
    }

    /** Called after a stored voice setting changes. */
    onSettingsUpdated(listener: () => void): () => void {
        this.#settingsListeners.add(listener);
        return () => {
            this.#settingsListeners.delete(listener);
        };
    }

    /** The machine voice settings exactly as `config.voice` reports them. */
    async voiceSettings(): Promise<VoiceConfig> {
        const settings = this.#config.voiceSettings;
        const effective = this.#config.voiceController(settings);
        const accounts = await this.#config.voiceAccounts().catch(() => []);
        return {
            controller: {
                providerId: settings.controller_provider ?? null,
                modelId: settings.controller_model ?? null,
                effort: settings.controller_effort ?? null,
                fastMode: settings.controller_fast_mode ?? false,
                speed: settings.controller_speed ?? null,
            },
            effectiveController: {
                providerId: effective.providerId,
                modelId: effective.modelId,
                effort: effective.effort,
                serviceTier: effective.serviceTier,
                speed: effective.speed,
                speeds: [...effective.speeds],
                notice: effective.notice,
            },
            accounts: accounts.map((account) => ({ ...account })),
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
            systemPromptOverride: settings.system_prompt ?? null,
            effectiveSystemPrompt: settings.system_prompt ?? LIVE_VOICE_INSTRUCTIONS,
        };
    }

    /**
     * HTTP authorization is owned by API. Omitted values are unchanged, `null` removes the stored
     * value, and the built-in prompt is never stored. Throws VoiceSettingsError for a refused change.
     */
    async updateVoiceSettings(ctx: Context, patch: VoiceConfigPatch): Promise<VoiceConfig> {
        if (!Value.Check(voiceConfigPatchSchema, patch))
            throw new VoiceSettingsError("The voice settings are invalid.");
        const controller = patch.controller;
        const prompt = patch.systemPrompt;
        const update: VoiceSettingsUpdate = {
            ...(controller?.providerId === undefined
                ? {}
                : { controller_provider: controller.providerId }),
            ...(controller?.modelId === undefined ? {} : { controller_model: controller.modelId }),
            ...(controller?.effort === undefined ? {} : { controller_effort: controller.effort }),
            ...(controller?.fastMode === undefined
                ? {}
                : { controller_fast_mode: controller.fastMode }),
            ...(controller?.speed === undefined ? {} : { controller_speed: controller.speed }),
            ...(prompt === undefined
                ? {}
                : { system_prompt: prompt === LIVE_VOICE_INSTRUCTIONS ? null : prompt }),
        };
        if (await this.#config.updateRuntimeVoiceSettings(ctx, update))
            for (const listener of this.#settingsListeners) listener();
        return await this.voiceSettings();
    }

    async voiceSettingsForAdmin(ctx: Context, agentId: string): Promise<VoiceConfig> {
        await this.#requireAdmin(ctx, agentId);
        return await this.voiceSettings();
    }

    async updateVoiceSettingsForAdmin(
        ctx: Context,
        agentId: string,
        patch: VoiceConfigPatch,
    ): Promise<VoiceConfig> {
        await this.#requireAdmin(ctx, agentId);
        return await this.updateVoiceSettings(ctx, patch);
    }

    /** The person's conversations in sidebar order, with agent IDs for targeting. */
    async voiceDirectory(ctx: Context, ownerId: string): Promise<VoiceDirectory> {
        return await readVoiceDirectory(
            ctx,
            {
                agents: this.#requireAgents(),
                bots: this.#bots,
                tasks: this.#tasks,
                subtasks: this.#subtasks,
                projects: this.#projects,
                workspaces: this.#workspaces,
            },
            ownerId,
            (await readVoiceAgent(ctx, ownerId))?.agentId,
        );
    }

    /**
     * `list_sidebar`, as the phones' `listConversations`: every conversation the person has here,
     * those started during the call included, filtered by a case-insensitive substring of the
     * title or the path it sits under, a page at a time, never the whole sidebar at once.
     */
    async voiceSidebar(
        ctx: Context,
        ownerId: string,
        voiceAgentId: string,
        input: { readonly query?: string; readonly cursor?: string } = {},
    ): Promise<string> {
        const call = this.#requests.get(voiceAgentId)?.call;
        const directory = await this.voiceDirectory(ctx, ownerId);
        const query = input.query?.trim().toLowerCase() ?? "";
        const matches = directory.rows.filter(
            (row) =>
                query === "" ||
                row.title.toLowerCase().includes(query) ||
                [...row.parents, row.title].join(" > ").toLowerCase().includes(query),
        );
        const start = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
        const runs = await this.#runActivity();
        const rows = [];
        let index = start;
        for (; index < matches.length && rows.length < VOICE_SIDEBAR_PAGE; index++) {
            const row = matches[index]!;
            const state = await this.#rowState(row.agentId, runs).catch(() => undefined);
            const ref = call?.refs.ref(row.agentId);
            const entry = {
                agentId: row.agentId,
                title: row.title,
                kind: row.kind,
                ...(row.parents.length === 0 ? {} : { parents: row.parents }),
                ...(ref === undefined ? {} : { ref }),
                ...(state === undefined
                    ? {}
                    : {
                          working: state.working,
                          needsPerson: state.needsPerson,
                          ...(state.question === undefined
                              ? {}
                              : { asks: cutWords(state.question, 512) }),
                          ...(state.failed === undefined
                              ? {}
                              : { failed: cutWords(state.failed, 512) }),
                          ...(state.lastActivityAt === undefined || call === undefined
                              ? {}
                              : { lastActivity: this.#when(call, state.lastActivityAt) }),
                      }),
            };
            if (Buffer.byteLength(JSON.stringify([...rows, entry])) > VOICE_SIDEBAR_BYTES) break;
            rows.push(entry);
        }
        return JSON.stringify({
            rows,
            total: matches.length,
            ...(index < matches.length ? { nextCursor: String(index) } : {}),
        });
    }

    /** Several conversations at once, bounded so reading many stays cheap. */
    async readConversations(
        ctx: Context,
        ownerId: string,
        input: {
            readonly ids: readonly string[];
            readonly turns: number;
            readonly replies: number;
        },
    ): Promise<string> {
        const agents = this.#requireAgents();
        const directory = await this.voiceDirectory(ctx, ownerId);
        const modules = {
            agents,
            history: this.#history,
            events: this.#events,
            team: this.#team,
        };
        const reads = [];
        for (const id of input.ids)
            reads.push({
                id,
                text: await readVoiceConversation(ctx, modules, directory, id, input),
            });
        return formatConversationReads(reads, CONVERSATIONS_TEXT_LIMIT);
    }

    /** The person's Voice agent, if they have made a call; an archived one is still reported. */
    async voiceAgent(ctx: Context, ownerId: string): Promise<string | undefined> {
        return (await readVoiceAgent(ctx, ownerId))?.agentId;
    }

    /** Returns an allocation barrier, without waiting for external work in the caller's transaction. */
    async reserve(
        ctx: Context,
        ownerId: string,
        request: CreateLiveSessionRequest,
    ): Promise<{ session: LiveSession; allocated: Promise<string> }> {
        const capabilities = acceptedCapabilities(
            request.desktopCapabilities,
            request.localConnectionId,
        );
        if (
            !Value.Check(createLiveSessionRequestSchema, request) ||
            request.windowId !== request.context.windowId ||
            Buffer.byteLength(
                JSON.stringify({
                    type: "desktopContext",
                    revision: request.contextRevision,
                    context: request.context,
                }),
            ) > FRAME_BYTES ||
            (request.appState !== undefined &&
                (!capabilities.includes("appState") ||
                    Buffer.byteLength(JSON.stringify(request.appState)) > FRAME_BYTES)) ||
            (!capabilities.includes("appState") && namesTask(request.context))
        ) {
            throw new LiveError(
                400,
                "invalid_request",
                "The voice request or desktop context is invalid or too large.",
            );
        }
        if (this.#stopped) throw new LiveError(503, "live_unavailable", "Voice is shutting down.");
        let route: Call["route"];
        let credential: Call["credential"];
        try {
            // A pool that includes the voice credential's account freezes onto it: the call cannot
            // start unless that account is signed in, while another member may not be.
            route = await this.#config.liveControllerRoute(request.credential.providerId);
        } catch (error) {
            throw new LiveError(
                503,
                "live_unavailable",
                error instanceof VoiceControllerRouteError
                    ? error.message
                    : "Voice cannot use the selected controller model. Check the voice settings and the selected account.",
            );
        }
        try {
            credential = await this.#config.liveCredential(request.credential);
        } catch (error) {
            throw new LiveError(
                503,
                "live_unavailable",
                error instanceof VoiceCredentialPoolError
                    ? error.message
                    : "Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",
            );
        }
        return await ctx.inTx(async (tx) => {
            const id = request.id ?? createId();
            const existing = await readLiveSession(tx, id, ownerId);
            if (existing !== undefined)
                throw new LiveError(
                    409,
                    "conflict",
                    "This voice session ID has already been used.",
                    existing,
                );
            if (await liveSessionExists(tx, id))
                throw new LiveError(404, "not_found", "The voice session was not found.");
            await pruneLiveSessions(tx, ownerId, Date.now());
            const active = await activeLiveSessions(tx, ownerId);
            if (
                active.length >= 4 ||
                active.some((item) => item.session.windowId === request.windowId)
            )
                throw new LiveError(
                    409,
                    "conflict",
                    "This window already has voice, or the account has four active voice sessions.",
                );
            const voiceAgentId = await this.#ensureVoice(tx, ownerId);
            const now = Date.now();
            const session: LiveSession = {
                id,
                windowId: request.windowId,
                credential: request.credential,
                contextRevision: request.contextRevision,
                status: "starting",
                usage: { seconds: null, final: false },
                error: null,
                createdAt: now,
                updatedAt: now,
                endedAt: null,
                version: liveVersion(),
            };
            await saveLiveSession(tx, ownerId, session);
            const voiceInstructions =
                this.#config.voiceSettings.system_prompt ?? LIVE_VOICE_INSTRUCTIONS;
            const call: Call = {
                ownerId,
                session,
                context: structuredClone(request.context),
                request: structuredClone(request),
                route,
                credential,
                voiceAgentId,
                abort: new AbortController(),
                controllerAbort: new AbortController(),
                allocated: deferred<string>(),
                claimed: false,
                queue: Promise.resolve(),
                capabilities,
                voiceInstructions,
                ...(request.appState === undefined
                    ? {}
                    : { appState: structuredClone(request.appState) }),
                timeZone: voiceTimeZone(request.appState?.timeZone),
                refs: VoiceRefs.start([]),
                directory: { rows: [] },
                toldRows: [],
                listed: new Set(),
                contextText: "",
                backlog: [],
                toldStatus: new Map(),
                statusDirty: new Set(),
                updates: [],
                onScreen: null,
                followed: [],
                pieces: new Map(),
                toldAt: new Map(),
                slots: [],
                personTurns: [],
                requests: 0,
                queued: 0,
                queuedBytes: 0,
                fragments: [],
                sentFragments: new Set(),
                actions: new Map(),
                delegations: new Set(),
                frequentDiagnostics: 0,
                suppressedDiagnostics: 0,
                diagnosticTimes: new Map(),
            };
            // Observe rejection even when an outer transaction rolls back or the HTTP caller leaves.
            void call.allocated.promise.catch(() => undefined);
            afterCommit(tx, () => {
                this.#calls.set(id, call);
                this.#voiceOwners.set(voiceAgentId, ownerId);
                this.#diagnostic(call, {
                    event: "session.created",
                    controllerProviderId: route.model.providerId,
                    model: route.model.id,
                    effort: route.effort,
                    ...(route.serviceTier === undefined ? {} : { serviceTier: route.serviceTier }),
                    capabilities,
                    credentialKind: session.credential.type,
                    credentialProviderId: session.credential.providerId,
                    voiceAgentId,
                    context: liveContextSummary(call.context),
                });
                this.#emit({
                    ownerId,
                    type: "live.session.created",
                    payload: {
                        session,
                        ...(request.mutationId === undefined
                            ? {}
                            : { mutationId: request.mutationId }),
                    },
                });
            });
            await this.#durable.invoke(tx, {
                function: START,
                arguments: { id },
                operationId: `live:${id}`,
            });
            return { session, allocated: call.allocated.promise };
        });
    }

    async get(ctx: Context, ownerId: string, id: string): Promise<LiveSession> {
        return await ctx.inTx(async (tx) => {
            await pruneLiveSessions(tx, ownerId, Date.now());
            const session = await readLiveSession(tx, id, ownerId);
            if (session === undefined)
                throw new LiveError(404, "not_found", "The voice session was not found.");
            return session;
        });
    }

    async close(
        ctx: Context,
        ownerId: string,
        id: string,
        mutationId?: string,
    ): Promise<LiveSession> {
        return await ctx.inTx(async (tx) => {
            const session = await this.get(tx, ownerId, id);
            if (terminal(session) || session.status === "closing") return session;
            const next = await this.#update(
                tx,
                ownerId,
                session,
                { status: "closing", error: null },
                mutationId,
            );
            afterCommit(tx, () => {
                const call = this.#calls.get(id);
                if (call === undefined) return;
                call.controllerAbort.abort();
                this.#cancelActions(call);
                if (call.transport === undefined)
                    void this.#fail(call, "Voice was stopped before startup completed.");
                else
                    void call.transport
                        .close()
                        .catch(() =>
                            this.#fail(call, "The voice connection could not close cleanly."),
                        );
            });
            return next;
        });
    }

    async prepareControl(
        ctx: Context,
        ownerId: string,
        id: string,
        windowId: string,
    ): Promise<{ attach(socket: LiveControlSocket): LiveControlBinding; failed(): void }> {
        const session = await this.get(ctx, ownerId, id);
        const call = this.#calls.get(id);
        if (
            session.windowId !== windowId ||
            terminal(session) ||
            call === undefined ||
            call.claimed
        )
            throw new LiveError(
                409,
                "conflict",
                "This voice session cannot attach to that window or already has a controller.",
            );
        call.claimed = true;
        return {
            failed: () => {
                void this.#fail(
                    call,
                    "The desktop controller connection could not be established.",
                );
            },
            attach: (socket) => {
                if (terminal(call.session)) {
                    socket.close(1008, "Voice has ended.");
                    return { message() {}, closed() {} };
                }
                call.socket = socket;
                this.#diagnostic(call, { event: "control.attached" });
                clearTimeout(call.attachTimer);
                this.#send(call, {
                    type: "hello",
                    sessionId: id,
                    windowId,
                    contextRevision: call.session.contextRevision,
                    ...(call.request.desktopCapabilities === undefined
                        ? {}
                        : { capabilities: call.capabilities }),
                });
                this.#send(call, this.#statusFrame(call, call.session));
                for (const fragment of call.fragments) this.#send(call, fragment);
                return {
                    message: (text) =>
                        this.#enqueue(call, text.length * 3, async () => {
                            if (Buffer.byteLength(text) > FRAME_BYTES)
                                throw new Error(
                                    "The desktop control message exceeded its size limit.",
                                );
                            const message: unknown = JSON.parse(text);
                            if (!Value.Check(liveControlClientMessageSchema, message))
                                throw new Error("The desktop control message was invalid.");
                            await this.#message(call, message);
                        }),
                    closed: () => {
                        if (!terminal(call.session) && call.session.status !== "closing") {
                            this.#diagnostic(call, {
                                event: "control.lost",
                                reason: "connectionLost",
                            });
                            call.controllerLost = true;
                            delete call.socket;
                            void this.close(this.#context(), ownerId, id).catch(() =>
                                this.#fail(call, "The desktop controller disconnected."),
                            );
                        }
                    },
                };
            },
        };
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        await Promise.all(
            [...this.#calls.values()].map(async (call) => {
                // The desktop is told why before its socket goes: the daemon is stopping, which
                // ends the call as a restart would, not as the person's own End.
                if (!terminal(call.session))
                    await this.#change(call, {
                        status: "failed",
                        error: "Voice ended because Happy Agent stopped. Start a new call once it is running again.",
                        failureReason: "restart",
                        endedAt: Date.now(),
                    }).catch(() => undefined);
                call.controllerAbort.abort();
                this.#cancelActions(call);
                await call.transport?.close().catch(() => undefined);
                await call.queue;
            }),
        );
        // A call the provider never confirmed closed still keeps its recap, as a drop.
        for (const call of [...this.#calls.values()]) this.#dispose(call);
        await Promise.all([...this.#recapWrites]);
    }

    /**
     * Run one of Voice's desktop actions in the window of the call whose request it is working
     * on. The answer is the tool result Voice reads; refusals are results, never exceptions.
     */
    async runVoiceAction(
        _ctx: Context,
        agentId: string,
        action: LiveDesktopAction,
    ): Promise<string> {
        const request = this.#requests.get(agentId);
        if (request === undefined || !request.accepted)
            return refusal(
                "No voice call is active for this request, so there is no window to act on.",
            );
        const run = request.actions.then(() => this.#voiceAction(request, action));
        request.actions = run.catch(() => undefined);
        return await run;
    }

    async #voiceAction(request: Request, action: LiveDesktopAction): Promise<string> {
        const call = request.call;
        if (request.delivered || request.failure !== undefined || call.session.status !== "active")
            return refusal("This action was not started because this request has already ended.");
        const previous = request.executed.at(-1);
        if (previous?.round === request.rounds && previous.result.status !== "succeeded")
            return refusal(
                "This action was not started because an earlier action did not succeed.",
            );
        action = this.#windowTarget(call, action);
        let result = this.#localRefusal(call, action);
        if (result === undefined) {
            try {
                result = await this.#execute(
                    call,
                    request.delegationId,
                    action,
                    request.transcriptIds,
                );
            } catch (error) {
                if (error instanceof LiveControllerError && error.category === "invalidAction")
                    result = {
                        status: "refused",
                        code: "unavailable",
                        message: "That action is not available in this voice call's window.",
                    };
                else {
                    request.failure =
                        error instanceof LiveControllerError
                            ? error
                            : new LiveControllerError("uncertainAction", {
                                  phase: "desktopAction",
                                  reason: "actionUncertain",
                                  round: request.rounds,
                              });
                    if (request.failure.category === "capacity")
                        void this.#fail(call, request.failure.message);
                    void this.#requireAgents()
                        .abort(this.#context(), call.voiceAgentId)
                        .catch(() => undefined);
                    return refusal("The action's outcome is uncertain. Stop and do not retry it.");
                }
            }
        }
        request.executed.push({ action, result, round: request.rounds });
        if (
            action.type === "desktopState" &&
            result.status === "succeeded" &&
            result.output.type === "context"
        )
            return JSON.stringify({
                ...result,
                output: {
                    ...result.output,
                    context: liveControllerAppState(result.output.context, call.appState),
                },
                ...(call.capabilities.includes("agentTargets")
                    ? { agentTargets: { connectionId: call.request.localConnectionId } }
                    : {}),
            });
        return JSON.stringify(result);
    }

    /**
     * Voice names conversations by agent ID, from the references it is given. A window that did not
     * negotiate agent targets gets the target it lists for that agent instead; an agent it does not
     * list stays an agent target and is refused.
     */
    #windowTarget(call: Call, action: LiveDesktopAction): LiveDesktopAction {
        if (
            call.capabilities.includes("agentTargets") ||
            !("target" in action) ||
            !("kind" in action.target) ||
            action.target.kind !== "agent"
        )
            return action;
        const agentId = action.target.agentId;
        const entity = liveAppStateEntities(this.#view(call)).find(
            (candidate) =>
                candidate.session?.sessionId === agentId &&
                (this.#thisMachine(call) === undefined ||
                    candidate.connectionId === this.#thisMachine(call)),
        );
        if (entity?.session === undefined) return action;
        return (
            action.type === "desktopOpen"
                ? { ...action, target: entity.target }
                : { ...action, target: entity.session }
        ) as LiveDesktopAction;
    }

    /** Voice acts only on this daemon's own conversations, and names agents only when allowed. */
    #localRefusal(call: Call, action: LiveDesktopAction): LiveDesktopActionResult | undefined {
        const targets: (LiveActionTarget | LiveActionSession)[] =
            "target" in action ? [action.target] : [];
        if (
            targets.some((target) => "kind" in target && target.kind === "agent") &&
            !call.capabilities.includes("agentTargets")
        )
            return {
                status: "refused",
                code: "unavailable",
                message:
                    "This window cannot open conversations by agent ID. Read desktopState and use its targets.",
            };
        const local = this.#thisMachine(call);
        const connectionId =
            "target" in action
                ? action.target.connectionId
                : "connectionId" in action
                  ? action.connectionId
                  : undefined;
        if (local !== undefined && connectionId !== undefined && connectionId !== local)
            return {
                status: "refused",
                code: "forbidden",
                message: "Voice acts only on this machine's conversations, not another server's.",
            };
        return undefined;
    }

    /**
     * The person's one Voice: an unreported subtask of Happy, made the way Happy makes any subtask,
     * with its own conversation. It is made with their first call and again with the next
     * call after they archived it. Its opening turn runs on the voice settings' controller as new
     * agents are offered it; each request then runs on its call's frozen route.
     */
    async #ensureVoice(ctx: Context, ownerId: string): Promise<string> {
        const agents = this.#requireAgents();
        const stored = await readVoiceAgent(ctx, ownerId);
        if (stored !== undefined) {
            const config = await agents.config(ctx, stored.agentId);
            if (config !== undefined && typeof config.metadata?.["archivedAt"] !== "number")
                return stored.agentId;
        }
        const happy = await this.#bots.chiefOfStaff(ctx);
        if (happy === undefined)
            throw new LiveError(503, "live_unavailable", "Voice needs Happy, which is missing.");
        const agentId = createId();
        const controller = this.#config.voiceController(this.#config.voiceSettings);
        const provider = controller.providerId ?? undefined;
        // Its opening turn may start before this transaction's other callbacks run.
        this.#voiceOwners.set(agentId, ownerId);
        await this.#subtasks.create(
            ctx,
            happy.agentId,
            {
                title: "Voice",
                text: VOICE_AGENT_OPENING,
                ...(provider === undefined ? {} : { provider }),
                model: controller.modelId,
                effort: controller.effort as CreateSubtaskInput["effort"],
                // Its opening turn only confirms it is set up; requests carry the call's own tier.
                ...(controller.serviceTier === null ? {} : { serviceTier: "priority" as const }),
            },
            agentId,
            undefined,
            provider === undefined ? undefined : { provider, model: controller.modelId },
            // Happy hears nothing from Voice; its work shows in its own conversation and row.
            { unreported: true },
        );
        await saveVoiceAgent(ctx, ownerId, agentId, Date.now());
        return agentId;
    }

    /** Voice's fixed arrays, merged: sidebar reads, then the desktop of the call it serves. */
    #voiceTools(ownerId: string, agentId: string): AnyAgentTool[] {
        const capabilities = this.#requests.get(agentId)?.call.capabilities ?? [];
        return [
            ...voiceSidebarTools(this, ownerId, agentId),
            ...liveDesktopTools(this, agentId),
            ...voiceCallTools(this, agentId),
            ...(capabilities.includes("taskCreate") ? liveTaskCreateTools(this, agentId) : []),
            ...(capabilities.includes("sessionModelChange")
                ? liveModelChangeTools(this, agentId)
                : []),
        ];
    }

    async #start(call: Call): Promise<void> {
        try {
            const context = await this.#firstContext(call);
            call.transport = await createLiveProviderTransport({
                credential: call.credential,
                sdp: call.request.sdp,
                instructions: call.voiceInstructions,
                initialContext: context,
                signal: call.abort.signal,
                onEvent: (event) =>
                    this.#enqueue(call, Buffer.byteLength(JSON.stringify(event)), () =>
                        this.#providerEvent(call, event),
                    ),
            });
            call.request.sdp = "";
            delete call.request.appState;
            call.contextText = context;
            this.#contextPushed(call, "context", [context], false);
            if (terminal(call.session) || call.session.status === "closing") {
                call.transport.dispose();
                throw new Error("Voice stopped during startup.");
            }
            if (call.socket === undefined) {
                call.attachTimer = setTimeout(() => {
                    void this.#fail(call, "The desktop did not attach to voice within 15 seconds.");
                }, 15_000);
                call.attachTimer.unref();
            }
            call.allocated.resolve(call.transport.sdp);
        } catch (error) {
            await this.#fail(
                call,
                error instanceof LiveProviderError
                    ? error.message
                    : "Voice could not start on the selected account. Check GPT-Live access and connectivity; no fallback or retry was attempted.",
                error instanceof LiveProviderError ? error : undefined,
            );
        }
    }

    async #providerEvent(call: Call, event: LiveProviderEvent): Promise<void> {
        if (terminal(call.session)) return;
        if (event.type === "ready") {
            this.#diagnostic(call, { event: "provider.ready" });
            if (call.session.status === "starting") {
                await this.#change(call, { status: "active" });
                await this.#greet(call);
                // A directory that changed during startup reaches voice once it can be told.
                this.#queueDirectory(call);
            }
        } else if (event.type === "usage") {
            await this.#change(call, {
                usage: event.final
                    ? { seconds: event.seconds, final: true }
                    : { seconds: event.seconds, final: false },
            });
        } else if (event.type === "ended") {
            await this.#change(call, {
                status: event.orderly && !call.controllerLost ? "closed" : "failed",
                error: call.controllerLost
                    ? "The desktop controller disconnected."
                    : event.orderly
                      ? null
                      : (event.error ?? "The voice connection ended unexpectedly."),
                ...(call.controllerLost
                    ? { failureReason: "controlLost" as const }
                    : event.orderly
                      ? {}
                      : { failureReason: event.reason ?? "connectionLost" }),
                endedAt: Date.now(),
            });
            call.allocated.reject(
                new LiveError(
                    event.code === "forbidden" ? 403 : event.code === "unsupported" ? 501 : 503,
                    event.code ?? "live_unavailable",
                    event.error ?? "Voice ended before startup completed.",
                    call.session,
                ),
            );
            this.#dispose(call);
        } else if (event.type === "transcript") {
            const fragment: Fragment = {
                type: "transcript",
                transcriptId: createId(),
                role: event.role,
                text: event.text,
                ...("startMs" in event && event.startMs !== undefined
                    ? { startMs: event.startMs, endMs: event.endMs! }
                    : {}),
            };
            if (!Value.Check(liveControlServerMessageSchema, fragment))
                throw new Error("The voice transcript exceeded its protocol limits.");
            call.fragments.push(fragment);
            const turnStarts = fragment.role === "user" && call.lastSpeaker !== "user";
            this.#said(call, fragment.role, fragment.text);
            // A turn's first words are the cue for held context; a change during the turn,
            // such as a click while the person is still speaking, waits for the next one.
            if (turnStarts) {
                call.personSpokeAt = Date.now();
                void this.#flush(call);
            }
            this.#diagnostic(call, {
                event: "transcript.received",
                transcriptId: fragment.transcriptId,
                role: fragment.role,
                characters: fragment.text.length,
            });
            while (
                call.fragments.length > 32 ||
                Buffer.byteLength(JSON.stringify(call.fragments)) > 65536
            )
                call.sentFragments.delete(call.fragments.shift()!.transcriptId);
            this.#send(call, fragment);
        } else if (event.type === "delegation") {
            if (call.session.status !== "active" || call.socket === undefined)
                throw new Error("Voice requested an action before the desktop was ready.");
            if (call.delegations.has(event.delegationId)) return;
            if (call.delegations.size >= 256)
                throw new Error("Voice exceeded its bounded delegation capacity.");
            call.delegations.add(event.delegationId);
            // Background context waits until this request's outcome is delivered.
            call.requests += 1;
            const fragments = [...call.fragments];
            const queuedAt = Date.now();
            this.#diagnostic(call, {
                event: "delegation.queued",
                delegationId: event.delegationId,
                characters: event.text?.length ?? 0,
                fragmentCount: fragments.length,
                inputTranscriptIds: fragments.map((fragment) => fragment.transcriptId),
                inFlight: call.requests,
            });
            // One request at a time reaches the person's Voice, across every call of theirs.
            void this.#voiceQueue(call.ownerId)
                .runInLock(this.#requestContext(), (ctx) =>
                    this.#handle(ctx, call, event.delegationId, event.text, fragments, queuedAt)
                        .catch(() => undefined)
                        .finally(() => this.#clearFocus(call)),
                )
                .finally(() => {
                    call.requests -= 1;
                    if (call.requests === 0) void this.#flush(call);
                });
        }
    }

    /**
     * Give one request to Voice and deliver its one outcome: the fixed outcome of verified
     * terminal actions, Voice's final text, or a fixed explanation. Voice's turn settles before
     * the next request reaches it, so two requests never share a turn.
     */
    async #handle(
        ctx: Context,
        call: Call,
        delegationId: string,
        delegationText: string | undefined,
        fragments: readonly Fragment[],
        queuedAt: number,
    ): Promise<void> {
        if (call.session.status !== "active" || call.controllerAbort.signal.aborted) return;
        const request: Request = {
            call,
            delegationId,
            messageId: createId(),
            transcriptIds: fragments.map((fragment) => fragment.transcriptId),
            accepted: false,
            rounds: 0,
            executed: [],
            actions: Promise.resolve(),
            inferenceText: "",
            text: "",
            delivered: false,
            startedAt: Date.now(),
            settled: deferred<string | undefined>(),
        };
        if (request.startedAt - queuedAt >= REQUEST_DEADLINE_MS) {
            await this.#deliver(
                request,
                "This desktop request expired while waiting in the queue. No action was started for it.",
                "controller",
            );
            return;
        }
        const mentioned = liveMentionedTarget(
            this.#view(call),
            delegationText ??
                fragments
                    .filter((fragment) => fragment.role === "user")
                    .slice(-4)
                    .map((fragment) => fragment.text)
                    .join("\n"),
        );
        if (mentioned !== undefined) this.#focus(call, mentioned, "mention");
        this.#diagnostic(call, {
            event: "delegation.started",
            delegationId,
            characters: delegationText?.length ?? 0,
            fragmentCount: fragments.length,
            inputTranscriptIds: request.transcriptIds,
            context: liveContextSummary(call.context),
        });
        const agents = this.#requireAgents();
        const agentId = call.voiceAgentId;
        this.#requests.set(agentId, request);
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), REQUEST_DEADLINE_MS);
        timer.unref();
        try {
            // Voice starts from what voice was told: the first context once, then each update.
            const hash = createHash("sha256").update(call.contextText).digest("hex");
            const sent = (await readVoiceAgent(ctx, call.ownerId))?.outlineSent;
            const updates = call.updates.splice(0);
            const message = requestMessage({
                delegation: delegationText,
                fragments: fragments.filter(
                    (fragment) => !call.sentFragments.has(fragment.transcriptId),
                ),
                now: voiceClock(Date.now(), call.timeZone),
                personSaid: call.personTurns.map((turn) => turn.trim()).filter(Boolean),
                thisMachine: this.#thisMachine(call),
                refs: Object.fromEntries(
                    [...call.listed].flatMap((agentId) => {
                        const ref = call.refs.ref(agentId);
                        return ref === undefined ? [] : [[ref, agentId]];
                    }),
                ),
                ...(hash === sent ? {} : { context: call.contextText }),
                updates,
            });
            await agents.send(
                ctx,
                agentId,
                { role: "user", content: [{ type: "text", text: message.text }] },
                {
                    id: request.messageId,
                    // Speech is provider-derived context, never the person's authorization.
                    metadata: { ...AGENT_MESSAGE_ORIGIN_METADATA },
                    provider: call.route.model.providerId,
                    model: call.route.model.id,
                    effort: call.route.effort,
                    serviceTier: call.route.serviceTier ?? null,
                    permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
                },
            );
            for (const id of message.transcriptIds) call.sentFragments.add(id);
            if (message.context) await saveOutlineSent(ctx, call.ownerId, agentId, hash);
            const ended = await settledOrStopped(request, [
                deadline.signal,
                call.controllerAbort.signal,
                call.route.signal,
            ]);
            if (ended !== "settled") {
                // The call ended, the account went away, or the deadline passed: stop Voice's
                // turn, say why, and let it settle before anything else reaches Voice.
                await agents.abort(ctx, agentId).catch(() => undefined);
                if (call.route.signal.aborted && call.session.status === "active")
                    await this.#fail(
                        call,
                        "The configured desktop controller account is no longer available.",
                    );
                request.failure ??= new LiveControllerError("deadline", {
                    phase: "providerStream",
                    reason: "deadline",
                    round: actionRound(request),
                });
                await this.#deliver(request, request.failure.voiceContext, "controller");
                await settledOrStopped(request, [AbortSignal.timeout(SETTLE_GRACE_MS)]);
                return;
            }
            const error = await request.settled.promise;
            if (request.failure === undefined && (error !== undefined || request.providerError))
                request.failure = new LiveControllerError("inference", {
                    phase: "providerDone",
                    reason: "providerError",
                    round: actionRound(request),
                    ...(request.providerError === undefined
                        ? {}
                        : {
                              providerErrorKind: request.providerError.kind,
                              ...(request.providerError.type === undefined
                                  ? {}
                                  : { providerErrorType: request.providerError.type }),
                          }),
                });
            if (request.failure !== undefined) {
                this.#failed(request, request.failure);
                await this.#deliver(request, request.failure.voiceContext, "controller");
                return;
            }
            if (request.pendingFixed !== undefined)
                await this.#deliver(request, request.pendingFixed, "fixed");
            this.#diagnostic(call, {
                event: "controller.finished",
                delegationId,
                durationMs: Date.now() - request.startedAt,
                characters: request.text.length,
                outcome: request.delivered ? "fixed" : "controller",
            });
            await this.#deliver(
                request,
                request.text || "The desktop request has completed.",
                "controller",
            );
        } catch {
            const failure = new LiveControllerError("inference", {
                phase: "providerOpen",
                reason: "providerRequestFailed",
            });
            this.#failed(request, failure);
            await this.#deliver(request, failure.voiceContext, "controller");
        } finally {
            clearTimeout(timer);
            if (this.#requests.get(agentId) === request) this.#requests.delete(agentId);
            for (const pending of call.actions.values()) {
                if (pending.delegationId === delegationId && pending.result === undefined) {
                    pending.expired = true;
                    clearTimeout(pending.timer);
                    pending.resolve({
                        status: "failed",
                        code: "failed",
                        message: "The request ended before the action's outcome was confirmed.",
                    });
                }
            }
        }
    }

    #failed(request: Request, failure: LiveControllerError): void {
        this.#diagnostic(request.call, {
            event: "controller.failed",
            delegationId: request.delegationId,
            durationMs: Date.now() - request.startedAt,
            category: failure.category,
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            actionCount: request.executed.length,
        });
    }

    /**
     * Happy speaks first, as the phones' hosted agent does. A line in the startup context did not
     * reliably start speech, so voice is cued once the call is active, as the phones cue it.
     */
    async #greet(call: Call): Promise<void> {
        if (call.transport === undefined) return;
        try {
            await call.transport.append({
                delegationId: null,
                text: LIVE_GREETING_CUE,
                speakable: true,
            });
            this.#contextPushed(call, "greeting", [LIVE_GREETING_CUE], true);
        } catch {
            // A missed greeting never fails the call; the person can still speak first.
        }
    }

    /** End the call a request came from once its turn settles, because the person asked. */
    endVoiceCall(agentId: string): string {
        const request = this.#requests.get(agentId);
        if (request === undefined || !request.accepted)
            return refusal("No voice call is active for this request, so there is no call to end.");
        request.endCall = true;
        return JSON.stringify({ status: "succeeded", output: { type: "ack" } });
    }

    /** The one spoken outcome of a request; nothing later from the same request is spoken. */
    async #deliver(request: Request, text: string, outcome: "fixed" | "controller"): Promise<void> {
        if (request.delivered) return;
        request.delivered = true;
        const call = request.call;
        if (request.endCall) {
            // Voice already said goodbye; give its audio a moment, then end as the person's End.
            clearTimeout(call.endTimer);
            call.endTimer = setTimeout(() => {
                void this.close(this.#context(), call.ownerId, call.session.id).catch(
                    () => undefined,
                );
            }, END_CALL_DELAY_MS);
            call.endTimer.unref();
            this.#diagnostic(call, {
                event: "delegation.delivered",
                delegationId: request.delegationId,
                outcome,
                durationMs: Date.now() - request.startedAt,
            });
            return;
        }
        if (terminal(call.session) || call.session.status !== "active") return;
        try {
            if (call.transport === undefined)
                throw new Error("The voice transport is unavailable.");
            const inFlight = call.requests;
            const outcomeHint = inFlight > 1 ? "queued" : "later";
            const instructions =
                outcomeHint === "queued"
                    ? LIVE_QUEUED_REQUEST_INSTRUCTIONS
                    : LIVE_LATER_REQUEST_INSTRUCTIONS;
            const outcomeText = `${text}\n\n${instructions}`;
            await call.transport.append({
                delegationId: request.delegationId,
                text: outcomeText,
                speakable: true,
            });
            this.#contextPushed(call, "outcome", [outcomeText], true);
            this.#diagnostic(call, {
                event: "delegation.delivered",
                delegationId: request.delegationId,
                inFlight,
                outcomeHint,
                outcome,
                durationMs: Date.now() - request.startedAt,
            });
        } catch {
            this.#diagnostic(call, {
                event: "delivery.failed",
                delegationId: request.delegationId,
                reason: "responseDelivery",
                durationMs: Date.now() - request.startedAt,
            });
            if (call.session.status === "active")
                await this.#fail(
                    call,
                    "Voice could not deliver the desktop controller's response. Its outcome was not retried.",
                );
        }
    }

    /** Verified terminal actions answer the request themselves, without Voice's words. */
    #fixedOutcome(request: Request): string | undefined {
        if (
            request.executed.length === 0 ||
            request.executed.some(({ result }) => result.status !== "succeeded")
        )
            return undefined;
        const names = new Map<string, string>();
        for (const row of request.call.directory.rows)
            if (!names.has(row.agentId)) names.set(row.agentId, row.title);
        return liveFixedOutcome(
            request.executed,
            this.#view(request.call),
            request.call.context,
            names,
        );
    }

    async #message(call: Call, message: LiveControlClientMessage): Promise<void> {
        if (terminal(call.session)) return;
        if (message.type === "desktopContext") {
            if (message.context.windowId !== call.session.windowId)
                throw new Error("The desktop context belongs to a different window.");
            if (message.revision < call.session.contextRevision) return;
            if (message.revision === call.session.contextRevision) {
                if (!Value.Equal(message.context, call.context))
                    throw new Error("Conflicting desktop contexts used the same revision.");
                return;
            }
            if (!call.capabilities.includes("appState") && namesTask(message.context))
                throw new Error("The desktop named a task without negotiating AppState.");
            call.context = message.context;
            await this.#change(call, { contextRevision: message.revision });
            this.#diagnostic(call, {
                event: "context.accepted",
                context: liveContextSummary(call.context),
            });
            await this.#focusChanged(call, message.revision);
        } else if (message.type === "actionResult") {
            const pending = call.actions.get(message.actionId);
            if (pending === undefined) throw new Error("The desktop answered an unknown action.");
            if (pending.expired) {
                if (!pending.lateLogged) {
                    pending.lateLogged = true;
                    this.#diagnostic(call, {
                        event: "action.lateIgnored",
                        delegationId: pending.delegationId,
                        actionId: message.actionId,
                        actionType: pending.action.type,
                    });
                }
                return;
            }
            if (pending.result !== undefined) {
                if (!Value.Equal(pending.result, message.result))
                    throw new Error("The desktop changed a completed action result.");
                return;
            }
            if (message.result.status === "pending") {
                if (!pending.pendingLogged) {
                    pending.pendingLogged = true;
                    this.#diagnostic(call, {
                        event: "action.result",
                        delegationId: pending.delegationId,
                        actionId: message.actionId,
                        actionType: pending.action.type,
                        resultStatus: "pending",
                        durationMs: Date.now() - pending.startedAt,
                    });
                }
                if (pending.action.type === "sessionSend")
                    throw new Error(
                        "Message staging cannot wait for human confirmation as a pending action.",
                    );
                return;
            }
            // A desktop that sends answers `ack`; one that can only stage answers `staged`.
            if (
                message.result.status === "succeeded" &&
                (pending.action.type === "sessionSend"
                    ? message.result.output.type !== "staged" &&
                      message.result.output.type !== "ack"
                    : message.result.output.type === "staged")
            )
                throw new Error("The desktop returned an invalid send result.");
            clearTimeout(pending.timer);
            pending.result = message.result;
            this.#diagnostic(call, {
                event: "action.result",
                delegationId: pending.delegationId,
                actionId: message.actionId,
                actionType: pending.action.type,
                resultStatus: message.result.status,
                durationMs: Date.now() - pending.startedAt,
                ...(message.result.status === "succeeded"
                    ? {
                          outputType: message.result.output.type,
                          ...(message.result.output.type === "context"
                              ? { context: liveContextSummary(message.result.output.context) }
                              : {}),
                      }
                    : { resultCode: message.result.code }),
            });
            pending.resolve(message.result);
        } else if (message.type === "appState") {
            if (!call.capabilities.includes("appState"))
                throw new Error("The desktop sent AppState without negotiating it.");
            // AppState only resolves names and targets and validates models; it is never pushed.
            if (call.appState !== undefined && Value.Equal(call.appState, message.appState)) return;
            call.appState = message.appState;
            this.#diagnostic(call, {
                event: "appState.accepted",
                bytes: Buffer.byteLength(JSON.stringify(message.appState)),
            });
        } else {
            // Session updates are accepted under their rules but never reach voice or Voice.
            const key = sessionKey(message.target);
            if (
                call.context.activeSession === null ||
                sessionKey(call.context.activeSession.target) !== key
            )
                throw new Error("The desktop updated an unselected conversation.");
        }
    }

    /**
     * A send goes to its named conversation and never changes the screen. The desktop appends to
     * a draft only in the focused conversation, and models opened it without then appending, so
     * a draft that is not focused is opened first; a refused open is that action's result.
     */
    async #execute(
        call: Call,
        delegationId: string,
        action: LiveDesktopAction,
        inputTranscriptIds: string[],
    ): Promise<LiveDesktopActionResult> {
        if (
            action.type === "composerDraftAppend" &&
            (call.context.activeSession === null ||
                liveTargetKey(call.context.activeSession.target) !== liveTargetKey(action.target))
        ) {
            const opened = await this.#action(
                call,
                delegationId,
                { type: "desktopOpen", target: this.#conversationTarget(call, action.target) },
                inputTranscriptIds,
            );
            if (opened.status !== "succeeded") return opened;
        }
        const result = await this.#action(call, delegationId, action, inputTranscriptIds);
        // The reply to what voice sent is told as it is written.
        if (action.type === "sessionSend" && result.status === "succeeded") {
            // What comes next is a new message; the turns already sent are not sent again.
            call.personTurns = [];
            const agentId = await this.#localAgent(call, action.target);
            if (agentId !== undefined) await this.#follow(call, agentId);
        }
        return result;
    }

    async #action(
        call: Call,
        delegationId: string,
        action: LiveDesktopAction,
        inputTranscriptIds: string[],
    ): Promise<LiveDesktopActionResult> {
        if (terminal(call.session) || call.session.status !== "active" || call.socket === undefined)
            throw new Error("Voice cannot start another desktop action.");
        if (call.actions.size >= 256) throw new LiveControllerError("capacity");
        if (
            [...call.actions.values()].some(
                (pending) => pending.result === undefined && !pending.expired,
            )
        )
            throw new LiveControllerError("invalidAction");
        if (
            action.type === "sessionWatch" ||
            (action.type === "taskCreate" && !call.capabilities.includes("taskCreate")) ||
            (action.type === "sessionModelChange" &&
                !call.capabilities.includes("sessionModelChange")) ||
            (action.type === "desktopOpen" &&
                action.target.kind === "task" &&
                !call.capabilities.includes("appState"))
        )
            throw new LiveControllerError("invalidAction");
        const actionId = createId();
        const startedAt = Date.now();
        const result = deferred<LiveDesktopActionResult>();
        const timer = setTimeout(() => {
            const pending = call.actions.get(actionId);
            if (pending !== undefined) pending.expired = true;
            this.#diagnostic(call, {
                event: "action.expired",
                delegationId,
                actionId,
                actionType: action.type,
                durationMs: Date.now() - startedAt,
                reason: "actionTimeout",
            });
            result.reject(
                new LiveControllerError("uncertainAction", {
                    phase: "desktopAction",
                    reason: "actionUncertain",
                }),
            );
        }, 60_000);
        timer.unref();
        call.actions.set(actionId, {
            delegationId,
            action,
            resolve: result.resolve,
            timer,
            startedAt,
        });
        this.#diagnostic(call, {
            event: "action.requested",
            delegationId,
            actionId,
            ...liveActionSummary(action),
            context: liveContextSummary(call.context),
        });
        const target = this.#actionTarget(call, action);
        if (target !== undefined)
            this.#focus(call, target, action.type === "desktopOpen" ? "navigation" : "mention");
        this.#send(call, {
            type: "actionRequested",
            actionId,
            contextRevision: call.session.contextRevision,
            inputTranscriptIds,
            action,
        });
        return await result.promise;
    }

    #voiceQueue(ownerId: string): ReturnType<typeof asyncQueue> {
        let queue = this.#voiceQueues.get(ownerId);
        if (queue === undefined) {
            queue = asyncQueue();
            this.#voiceQueues.set(ownerId, queue);
        }
        return queue;
    }

    #enqueue(call: Call, bytes: number, work: () => Promise<void>): void {
        if (terminal(call.session)) return;
        if (++call.queued > 64 || (call.queuedBytes += bytes) > 1024 * 1024) {
            void this.#fail(call, "Voice exceeded its control queue limit.");
            return;
        }
        call.queue = call.queue
            .then(work)
            .catch(() => {
                this.#diagnostic(call, { event: "control.invalid", reason: "invalidControlData" });
                return this.#fail(
                    call,
                    "Voice received invalid or conflicting control data and ended safely.",
                );
            })
            .finally(() => {
                call.queued -= 1;
                call.queuedBytes -= bytes;
            });
    }

    #send(call: Call, message: LiveControlServerMessage): void {
        if (call.socket === undefined) return;
        if (!Value.Check(liveControlServerMessageSchema, message))
            throw new Error("The voice control response is invalid.");
        const text = JSON.stringify(message);
        if (Buffer.byteLength(text) > FRAME_BYTES)
            throw new Error("The voice control response is too large.");
        try {
            call.socket.send(text);
        } catch {
            delete call.socket;
            void this.#fail(call, "The desktop control connection could not keep up.");
        }
    }

    async #change(
        call: Call,
        changes: Omit<LiveSessionUpdatedChanges, "updatedAt">,
    ): Promise<void> {
        await this.#context().inTx(async (tx) => {
            const current = await readLiveSession(tx, call.session.id, call.ownerId);
            if (current === undefined || terminal(current)) return;
            await this.#update(tx, call.ownerId, current, changes);
        });
    }

    async #update(
        ctx: Context,
        ownerId: string,
        current: LiveSession,
        changes: Omit<LiveSessionUpdatedChanges, "updatedAt">,
        mutationId?: string,
    ): Promise<LiveSession> {
        const update = { ...changes, updatedAt: Date.now() };
        const session = { ...current, ...update, version: liveVersion(current.version) };
        await saveLiveSession(ctx, ownerId, session);
        afterCommit(ctx, () => {
            const call = this.#calls.get(session.id);
            if (call !== undefined) {
                call.session = session;
                if (changes.status !== undefined)
                    this.#diagnostic(call, { event: "session.status", status: session.status });
                this.#send(call, this.#statusFrame(call, session));
            }
            this.#emit({
                ownerId,
                type: "live.session.updated",
                payload: {
                    sessionId: session.id,
                    previousVersion: current.version,
                    version: session.version,
                    changes: update,
                    ...(mutationId === undefined ? {} : { mutationId }),
                },
            });
        });
        return session;
    }

    /** A failed call says why to a desktop that negotiated typed failure reasons. */
    #statusFrame(call: Call, session: LiveSession): LiveControlServerMessage {
        return {
            type: "status",
            status: session.status,
            error: session.error,
            ...(session.status === "failed" &&
            call.capabilities.includes("failureReasons") &&
            typeof session.failureReason === "string"
                ? { reason: session.failureReason }
                : {}),
        };
    }

    async #fail(call: Call, error: string, providerError?: LiveProviderError): Promise<void> {
        const failureReason =
            providerError?.reason ?? (call.controllerLost ? ("controlLost" as const) : undefined);
        if (!terminal(call.session))
            await this.#change(call, {
                status: "failed",
                error,
                ...(failureReason === undefined ? {} : { failureReason }),
                endedAt: Date.now(),
            });
        call.allocated.reject(
            new LiveError(
                providerError?.status ?? 503,
                providerError?.code ?? "live_unavailable",
                error,
                call.session,
            ),
        );
        this.#dispose(call);
    }
    #cancelActions(call: Call): void {
        for (const pending of call.actions.values()) {
            clearTimeout(pending.timer);
            if (pending.result === undefined)
                pending.resolve({
                    status: "cancelled",
                    code: "ended",
                    message: "Voice has ended; already-started actions may still complete.",
                });
        }
    }
    #dispose(call: Call): void {
        if (this.#calls.get(call.session.id) === call) this.#saveRecap(call);
        clearTimeout(call.attachTimer);
        clearTimeout(call.directoryTimer);
        clearTimeout(call.statusTimer);
        clearTimeout(call.endTimer);
        this.#cancelActions(call);
        call.abort.abort();
        // Stops Voice's turn for this call's request; Voice itself remains.
        call.controllerAbort.abort();
        call.transport?.dispose();
        call.socket?.close(1000, "Voice has ended.");
        this.#calls.delete(call.session.id);
    }
    /** The AppState names and targets resolve against: the desktop's own, or its context's. */
    #view(call: Call) {
        return liveAppStateView(call.context, call.appState);
    }

    /**
     * The call's first context, as the phones give it: when the call started on the person's
     * clock, the recap of earlier calls, the conversation on screen with its last turns, and the
     * directory with references, status and last activity. What it tells counts as known.
     */
    async #firstContext(call: Call): Promise<string> {
        const ctx = this.#context();
        const now = Date.now();
        let directory: VoiceDirectory = { rows: [] };
        let recap: VoiceCallSlot[] = [];
        try {
            directory = await this.voiceDirectory(ctx, call.ownerId);
            recap = await readCallHistory(ctx, call.ownerId);
        } catch {
            // The call still starts; voice is told what could be read.
        }
        call.directory = directory;
        call.refs = VoiceRefs.start(directory.rows.map((row) => row.agentId));
        const onScreen = await this.#localAgent(call, call.context.activeTarget);
        call.onScreen = onScreen ?? null;
        let screen: Parameters<typeof renderVoiceCallContext>[0]["onScreen"];
        if (onScreen !== undefined) {
            const row = directory.rows.find((item) => item.agentId === onScreen) ?? {
                agentId: onScreen,
                title: await this.#title(onScreen),
                kind: "subtask" as const,
                parents: [],
            };
            const turns = await this.#turns(onScreen);
            screen = {
                row,
                ref: call.refs.ref(onScreen),
                state: await this.#rowState(onScreen),
                turns,
            };
            this.#told(call, onScreen, turns);
            await this.#follow(call, onScreen);
        }
        const rows = await this.#rankedRows(call, directory);
        for (const { row, state } of rows)
            if (state !== undefined) call.toldStatus.set(row.agentId, statusKey(state));
        if (screen !== undefined) call.toldStatus.set(screen.row.agentId, statusKey(screen.state));
        const { text, listed } = renderVoiceCallContext({
            now,
            timeZone: call.timeZone,
            focusRevision: call.session.contextRevision,
            recap,
            onScreen: screen,
            rows,
            // A native call's voice prompt is a startup item too, so it comes out of the budget.
            bytes:
                VOICE_CONTEXT_BYTES -
                (call.credential.type === "codex_subscription"
                    ? Buffer.byteLength(call.voiceInstructions)
                    : 0),
        });
        // Voice holds references only for what it was shown; the rest are found by searching.
        call.listed = new Set(listed);
        call.toldRows = directory.rows.filter((row) => call.listed.has(row.agentId));
        return text;
    }

    /**
     * Every conversation with its state and its claim on the directory's budget: the one on screen
     * and the followed ones first, then the most recently active. A subtask's parents rank with it,
     * so a kept subtask always sits under its own conversation. Only those that can be listed are
     * asked whether they need the person.
     */
    async #rankedRows(call: Call, directory: VoiceDirectory) {
        // One query gives every conversation's last run, so ranking reads no conversation; the
        // create path waits on this before the call is allocated.
        const runs = await this.#runActivity();
        const activity = directory.rows.map((row) => runs.get(row.agentId)?.at);
        const recency = directory.rows
            .map((_row, index) => index)
            .sort((a, b) => (activity[b] ?? -1) - (activity[a] ?? -1) || a - b);
        const rank = new Map<string, number>();
        recency.forEach((index, position) => {
            const { agentId } = directory.rows[index]!;
            const first =
                agentId === call.onScreen ? 0 : call.followed.includes(agentId) ? 1 : undefined;
            rank.set(agentId, first ?? 2 + position);
        });
        const parent = new Map(
            directory.rows.flatMap((row) =>
                row.parentAgentId === undefined ? [] : [[row.agentId, row.parentAgentId] as const],
            ),
        );
        for (const row of directory.rows) {
            const own = rank.get(row.agentId)!;
            for (
                let current = parent.get(row.agentId), depth = 0;
                current !== undefined && depth < 16;
                current = parent.get(current), depth++
            )
                rank.set(current, Math.min(rank.get(current) ?? own, own));
        }
        const listable = new Set(
            [...rank.entries()]
                .sort((a, b) => a[1] - b[1])
                .slice(0, VOICE_DIRECTORY_ROWS)
                .map(([agentId]) => agentId),
        );
        return await Promise.all(
            directory.rows.map(async (row) => ({
                row,
                ref: call.refs.ref(row.agentId),
                rank: rank.get(row.agentId)!,
                state: listable.has(row.agentId)
                    ? await this.#rowState(row.agentId, runs).catch(() => undefined)
                    : undefined,
            })),
        );
    }

    /** Whether a conversation is working or needs the person, and when it last did something. */
    async #rowState(
        agentId: string,
        runs?: ReadonlyMap<string, { readonly at: number }>,
    ): Promise<VoiceRowState> {
        const ctx = this.#context();
        const [activity, pending] = await Promise.all([
            runs ?? this.#runActivity(),
            this.#userInput.list(ctx, agentId, { status: "pending", limit: 1 }),
        ]);
        const working = this.#events.activeRunId(agentId) !== undefined;
        const failed = working ? undefined : this.#failures.get(agentId);
        return {
            working,
            needsPerson: pending.length > 0,
            lastActivityAt: activity.get(agentId)?.at,
            ...(pending[0] === undefined ? {} : { question: pending[0].question }),
            ...(failed === undefined ? {} : { failed }),
        };
    }

    /** When each conversation's latest run ended or started, from one query. */
    async #runActivity(): Promise<ReadonlyMap<string, { readonly at: number }>> {
        try {
            return await this.#history.runActivity(this.#context());
        } catch {
            return new Map();
        }
    }

    async #turns(agentId: string): Promise<VoiceTurns> {
        try {
            return await readVoiceTurns(this.#context(), this.#history, agentId, 5);
        } catch {
            return { turns: [], older: false, lastPersonAt: undefined, lastReplyAt: undefined };
        }
    }

    async #title(agentId: string): Promise<string> {
        const title = (await this.#requireAgents().config(this.#context(), agentId))?.metadata?.[
            "title"
        ];
        return typeof title === "string" ? title : "Untitled";
    }

    /** Remember the newest message voice was told of a conversation, so it is never replayed. */
    #told(call: Call, agentId: string, turns: VoiceTurns): void {
        const newest = Math.max(
            call.toldAt.get(agentId) ?? 0,
            ...turns.turns.flatMap((turn) => [turn.message?.at ?? 0, turn.reply?.at ?? 0]),
        );
        call.toldAt.set(agentId, newest);
    }

    /** This computer's connection ID in the call's window. */
    #thisMachine(call: Call): string | undefined {
        return (
            call.request.localConnectionId ??
            call.appState?.servers.find((server) => server.kind === "local")?.connectionId ??
            (call.context.connections.length === 1
                ? call.context.connections[0]!.connectionId
                : undefined)
        );
    }

    /** The agent a desktop target's conversation is, when it is one of this daemon's. */
    async #localAgent(
        call: Call,
        target: LiveActionTarget | LiveActionSession | null,
    ): Promise<string | undefined> {
        if (target === null) return undefined;
        const local = this.#thisMachine(call);
        if (local !== undefined && target.connectionId !== local) return undefined;
        const agentId =
            "kind" in target
                ? target.kind === "agent"
                    ? target.agentId
                    : "sessionId" in target
                      ? target.sessionId
                      : undefined
                : target.sessionId;
        if (agentId === undefined) return undefined;
        const config = await this.#requireAgents()
            .config(this.#context(), agentId)
            .catch(() => undefined);
        return config === undefined ? undefined : agentId;
    }

    /** Make a conversation the newest of the four whose replies voice hears. */
    async #follow(call: Call, agentId: string): Promise<void> {
        if (agentId === call.voiceAgentId) return;
        if (!call.followed.includes(agentId) && !call.toldAt.has(agentId)) {
            // What is there when a conversation is first followed counts as known.
            const turns = await this.#turns(agentId);
            this.#told(call, agentId, turns);
        }
        call.followed = [agentId, ...call.followed.filter((id) => id !== agentId)];
        while (call.followed.length > 4) {
            const dropped = call.followed.findLast((id) => id !== call.onScreen);
            if (dropped === undefined) break;
            call.followed = call.followed.filter((id) => id !== dropped);
            // One that drops out and comes back is never replayed what it was already told.
            call.pieces.delete(dropped);
        }
    }

    /**
     * The screen in front changed. Voice is told the focus with its revision and, the first time
     * it sees that conversation, its recent turns with their times; later turns already told are
     * never replayed. A focused conversation becomes the newest followed one.
     */
    async #focusChanged(call: Call, revision: number): Promise<void> {
        const agentId = (await this.#localAgent(call, call.context.activeTarget)) ?? null;
        if (agentId === call.onScreen) return;
        call.onScreen = agentId;
        if (agentId === null) {
            this.#push(
                call,
                "focus",
                sortedJson({ event: "focus", focusRevision: revision, title: null }),
            );
            return;
        }
        const known = call.toldAt.get(agentId);
        const turns = await this.#turns(agentId);
        const fresh = turns.turns.filter((turn) =>
            [turn.message?.at, turn.reply?.at].some(
                (at) => known === undefined || (at !== undefined && at > known),
            ),
        );
        this.#told(call, agentId, turns);
        await this.#follow(call, agentId);
        const row = call.directory.rows.find((item) => item.agentId === agentId);
        const state = await this.#rowState(agentId).catch(() => undefined);
        const when = (at: number | undefined) =>
            at === undefined ? {} : { at: this.#when(call, at) };
        const title = row?.title ?? (await this.#title(agentId));
        const line = (shown: typeof fresh) =>
            sortedJson({
                event: "focus",
                focusRevision: revision,
                ...this.#naming(call, agentId, row),
                title,
                ...(state === undefined
                    ? {}
                    : {
                          working: state.working,
                          needsPerson: state.needsPerson,
                          ...(state.question === undefined
                              ? {}
                              : { asks: cutWords(state.question, 512) }),
                          ...(state.failed === undefined
                              ? {}
                              : { failed: cutWords(state.failed, 512) }),
                      }),
                ...(shown.length === 0
                    ? {}
                    : {
                          turns: shown.map((turn) => ({
                              ...(turn.message === undefined
                                  ? {}
                                  : {
                                        [turn.from === "agent" ? "anotherAgent" : "person"]: {
                                            text: turn.message.text,
                                            ...when(turn.message.at),
                                        },
                                    }),
                              ...(turn.reply === undefined
                                  ? {}
                                  : { agent: { text: turn.reply.text, ...when(turn.reply.at) } }),
                          })),
                      }),
            });
        // An update is at most 16 KiB, as the phones bound theirs; the oldest turns give way.
        this.#push(call, "focus", () => {
            let shown = fresh;
            while (shown.length > 0 && Buffer.byteLength(line(shown)) > VOICE_UPDATE_BYTES)
                shown = shown.slice(1);
            return line(shown);
        });
    }

    /** A time as voice says it, as of now, with the exact minute on the person's clock. */
    #when(call: Call, at: number): { ago: string; at: string } {
        return { ago: voiceAgo(Date.now() - at), at: voiceClock(at, call.timeZone) };
    }

    /** A conversation's parents and reference, as updates name it. */
    /**
     * How a line names a conversation. One voice was never shown is introduced: told with its kind
     * beside its title, then listed, so voice holds every reference it hears and the directory's
     * later changes include it.
     */
    #naming(call: Call, agentId: string, row: VoiceDirectoryRow | undefined) {
        const ref = call.refs.ref(agentId);
        const introduced = row !== undefined && ref !== undefined && !call.listed.has(agentId);
        if (introduced) {
            call.listed.add(agentId);
            call.toldRows = call.directory.rows.filter((item) => call.listed.has(item.agentId));
        }
        return {
            ...(introduced ? { kind: row.kind } : {}),
            ...(row === undefined || row.parents.length === 0 ? {} : { parents: row.parents }),
            ...(ref === undefined ? {} : { ref }),
        };
    }

    /** A followed conversation's words: each piece is told once, when it is complete. */
    #followedEvent(agentId: string, event: SessionEvent): void {
        for (const call of this.#calls.values()) {
            if (!call.followed.includes(agentId) || call.session.status !== "active") continue;
            if (event.type === "text_delta") {
                const piece = call.pieces.get(agentId) ?? "";
                if (piece.length < VOICE_REPLY_BYTES * 4)
                    call.pieces.set(agentId, piece + event.delta);
            } else if (event.type === "done" && event.state === "tool_call") {
                this.#tellPiece(call, agentId, false);
            }
        }
    }

    #followedSettled(agentId: string, error: string | undefined): void {
        for (const call of this.#calls.values()) {
            if (!call.followed.includes(agentId) || call.session.status !== "active") continue;
            this.#tellPiece(call, agentId, true);
            if (error === undefined) continue;
            const row = call.directory.rows.find((item) => item.agentId === agentId);
            const at = Date.now();
            this.#push(call, "error", () =>
                sortedJson({
                    at: this.#when(call, at),
                    event: "session_error",
                    ...this.#naming(call, agentId, row),
                    reason: cutWords(error, 1024),
                    title: row?.title ?? "Untitled",
                }),
            );
        }
    }

    #tellPiece(call: Call, agentId: string, finishedTurn: boolean): void {
        const text = call.pieces.get(agentId)?.trim() ?? "";
        call.pieces.delete(agentId);
        if (text === "") return;
        call.toldAt.set(agentId, Date.now());
        const row = call.directory.rows.find((item) => item.agentId === agentId);
        const cut = cutWords(text, VOICE_REPLY_BYTES);
        const at = Date.now();
        this.#push(call, "reply", () =>
            sortedJson({
                at: this.#when(call, at),
                event: "assistant_text",
                ...(finishedTurn ? { finishedTurn: true } : {}),
                ...this.#naming(call, agentId, row),
                text: cut,
                title: row?.title ?? "Untitled",
                ...(cut === text ? {} : { truncated: true }),
            }),
        );
    }

    /** Directory changes settle for a second from the first; a request holds them. */
    #queueDirectory(call: Call): void {
        if (call.session.status !== "active" || call.directoryTimer !== undefined) return;
        call.directoryTimer = setTimeout(() => {
            delete call.directoryTimer;
            void this.#tellDirectory(call);
        }, 1000);
        call.directoryTimer.unref();
    }

    /** Tell voice what changed in the directory since it was last told, never the whole again. */
    async #tellDirectory(call: Call): Promise<void> {
        if (call.session.status !== "active") return;
        try {
            const directory = await this.voiceDirectory(this.#context(), call.ownerId);
            const known = new Set(call.directory.rows.map((row) => row.agentId));
            call.directory = directory;
            // A conversation new since the last read is listed; one voice was never shown stays
            // unlisted, so voice only ever hears of references it holds.
            for (const agentId of call.refs.place(directory.rows.map((row) => row.agentId)))
                if (!known.has(agentId)) call.listed.add(agentId);
            const current = directory.rows.filter((row) => call.listed.has(row.agentId));
            const update = voiceDirectoryUpdate(call.toldRows, current, call.refs);
            call.toldRows = current;
            if (update !== undefined) this.#push(call, "directory", update);
        } catch {
            // The directory is background context; a failed read never fails the call.
        }
    }

    /** A conversation started or settled a run, or asked or stopped asking the person. */
    #statusChanged(agentId: string): void {
        for (const call of this.#calls.values()) {
            if (call.session.status !== "active" || agentId === call.voiceAgentId) continue;
            call.statusDirty.add(agentId);
            if (call.statusTimer !== undefined) continue;
            call.statusTimer = setTimeout(() => {
                delete call.statusTimer;
                void this.#tellStatus(call);
            }, 1000);
            call.statusTimer.unref();
        }
    }

    /**
     * Keep voice's status current, so a status question is answered from context: one silent
     * `status` line of what changed since voice was told, at most 20 changes within 4 KiB.
     */
    async #tellStatus(call: Call): Promise<void> {
        const dirty = [...call.statusDirty];
        call.statusDirty.clear();
        const changes: Record<string, unknown>[] = [];
        for (const agentId of dirty) {
            const row = call.directory.rows.find((item) => item.agentId === agentId);
            if (row === undefined) continue;
            const state = await this.#rowState(agentId).catch(() => undefined);
            if (state === undefined) continue;
            const key = statusKey(state);
            if (call.toldStatus.get(agentId) === key) continue;
            // An unlisted conversation is worth naming only once it works, needs the person, or
            // fails; naming it introduces it.
            if (
                !call.listed.has(agentId) &&
                !state.working &&
                !state.needsPerson &&
                state.failed === undefined
            )
                continue;
            call.toldStatus.set(agentId, key);
            changes.push({
                ...this.#naming(call, agentId, row),
                title: row.title,
                working: state.working,
                needsPerson: state.needsPerson,
                ...(state.question === undefined ? {} : { asks: cutWords(state.question, 512) }),
                ...(state.failed === undefined ? {} : { failed: cutWords(state.failed, 512) }),
            });
        }
        if (changes.length === 0) return;
        const kept: Record<string, unknown>[] = [];
        const render = (more: number) =>
            sortedJson({ changes: kept, event: "status", ...(more === 0 ? {} : { more }) });
        for (const change of changes.slice(0, 20)) {
            kept.push(change);
            if (Buffer.byteLength(render(0)) > 4096) {
                kept.pop();
                break;
            }
        }
        if (kept.length > 0) this.#push(call, "status", render(changes.length - kept.length));
    }

    /**
     * Background context is silent and goes in order. Any append may still make GPT-Live speak, so
     * lines wait for the person's next turn, when voice is about to answer anyway, and while a
     * request lacks its outcome.
     */
    #push(call: Call, kind: LiveContextKind, render: string | (() => string)): void {
        if (call.backlog.length >= 64) call.backlog.shift();
        call.backlog.push({ kind, render: typeof render === "string" ? () => render : render });
        void this.#flush(call);
    }

    async #flush(call: Call): Promise<void> {
        if (
            call.flushing ||
            call.requests > 0 ||
            Date.now() - (call.personSpokeAt ?? -Infinity) > PERSON_TURN_MS
        )
            return;
        call.flushing = true;
        try {
            while (call.backlog.length > 0 && call.requests === 0) {
                const transport = call.transport;
                if (call.session.status !== "active" || transport === undefined) return;
                const line = call.backlog.shift()!;
                const text = line.render();
                await transport.append({ delegationId: null, text, speakable: false });
                if (call.updates.length >= 64) call.updates.shift();
                call.updates.push(text);
                this.#contextPushed(call, line.kind, [text], false);
            }
        } catch {
            // Background context never fails the call.
        } finally {
            delete call.flushing;
            if (call.backlog.length > 0 && call.requests === 0) void this.#flush(call);
        }
    }

    /** What was said aloud, merged per speaker within the call, for the next call's recap. */
    #said(call: Call, role: "user" | "assistant", text: string): void {
        if (role === "user") {
            const last = call.personTurns.at(-1);
            if (call.lastSpeaker === "user" && last !== undefined)
                call.personTurns[call.personTurns.length - 1] = joinSpoken(last, text);
            else call.personTurns.push(text);
            while (
                call.personTurns.length > 20 ||
                Buffer.byteLength(JSON.stringify(call.personTurns)) > 8192
            )
                call.personTurns.shift();
        }
        call.lastSpeaker = role;
        const kind = role === "user" ? "person" : "assistant";
        const last = call.slots.at(-1);
        if (last?.kind === kind && last.text.length < 1024)
            call.slots[call.slots.length - 1] = {
                ...last,
                text: joinSpoken(last.text, text).slice(0, 1024),
            };
        else call.slots.push({ at: Date.now(), kind, text: text.slice(0, 1024) });
        if (call.slots.length > 30) call.slots.shift();
    }

    /** Keep this call's recap and how it ended; a plain end with nothing said leaves nothing. */
    #saveRecap(call: Call): void {
        const closed = call.session.status === "closed";
        if (call.slots.every((slot) => slot.text.trim() === "") && closed && !this.#stopped) return;
        const ending = this.#stopped
            ? "the call dropped (Happy Agent stopped on the computer)"
            : closed
              ? "the person ended the call"
              : call.controllerLost
                ? "the call dropped (the desktop disconnected)"
                : "the call ended with a problem";
        const slots = [
            ...call.slots.filter((slot) => slot.text.trim() !== ""),
            { at: Date.now(), kind: "ending" as const, text: ending },
        ];
        call.slots = [];
        const write = this.#context()
            .inTx(async (tx) => await appendCallHistory(tx, call.ownerId, slots, Date.now()))
            .catch(() => undefined)
            .finally(() => this.#recapWrites.delete(write));
        this.#recapWrites.add(write);
    }

    /**
     * Highlight what voice is talking about. Decorative, and never sent without the capability.
     * The same target is repeated only to announce that it is about to be opened.
     */
    #focus(call: Call, target: LiveDesktopTarget, reason: "mention" | "navigation"): void {
        const key = liveTargetKey(target);
        if (
            !call.capabilities.includes("voiceFocus") ||
            (call.focus?.key === key && (reason === "mention" || call.focus.reason === reason))
        )
            return;
        call.focus = { key, reason };
        this.#send(call, {
            type: "voiceFocus",
            focusId: createId(),
            contextRevision: call.session.contextRevision,
            target,
            reason,
        });
        this.#diagnostic(call, { event: "focus.sent", focusReason: reason });
    }

    #clearFocus(call: Call): void {
        if (call.focus === undefined) return;
        delete call.focus;
        if (terminal(call.session)) return;
        this.#send(call, {
            type: "voiceFocus",
            focusId: createId(),
            contextRevision: call.session.contextRevision,
            target: null,
            reason: "mention",
        });
        this.#diagnostic(call, { event: "focus.sent", focusReason: "clear" });
    }

    /** The desktop target an action is about, named as the sidebar names it. */
    #actionTarget(call: Call, action: LiveDesktopAction): LiveDesktopTarget | undefined {
        if (!("target" in action)) return undefined;
        const target =
            action.type === "desktopOpen"
                ? action.target
                : this.#conversationTarget(call, action.target);
        // Focus names desktop entities; the desktop resolves an agent target itself.
        return "kind" in target && target.kind === "agent"
            ? undefined
            : (target as LiveDesktopTarget);
    }

    /** A conversation as the sidebar shows it: a bot, a task, or an ordinary session. */
    #conversationTarget(call: Call, ref: LiveActionSession): LiveActionTarget {
        if ("kind" in ref) return ref;
        const key = liveTargetKey(ref);
        return (
            liveAppStateEntities(this.#view(call)).find((entity) => entity.key === key)?.target ??
            call.context.bots.find((bot) => liveTargetKey(bot.target) === key)?.target ?? {
                kind: "session",
                ...ref,
            }
        );
    }

    async #requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.#isAdmin(ctx, agentId)))
            throw new Error("Only an active admin bot can read or change voice settings.");
    }

    async #isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("Voice has not started.");
        return this.#agents;
    }

    #emit(event: LiveEvent): void {
        for (const listener of this.#listeners) listener(event);
    }
    /** Records what the voice model was told: metadata in the log, text only in test capture. */
    #contextPushed(call: Call, kind: LiveContextKind, appends: string[], speakable: boolean): void {
        this.#diagnostic(call, {
            event: "context.pushed",
            kind,
            speakable,
            appendCount: appends.length,
            bytes: appends.reduce((sum, part) => sum + Buffer.byteLength(part), 0),
        });
        captureLiveContext({ kind, text: appends.join(""), speakable });
    }
    #diagnostic(call: Call, diagnostic: LiveDiagnostic): void {
        try {
            const now = Date.now();
            // Only these streaming event kinds may grow independently of the call's action bounds.
            if (
                diagnostic.event === "context.accepted" ||
                diagnostic.event === "transcript.received"
            ) {
                if (
                    call.frequentDiagnostics >= 1024 ||
                    now - (call.diagnosticTimes.get(diagnostic.event) ?? 0) < 100
                ) {
                    call.suppressedDiagnostics++;
                    return;
                }
                call.frequentDiagnostics++;
                call.diagnosticTimes.set(diagnostic.event, now);
            }
            logLiveDiagnostic(
                this.#context(),
                {
                    sessionId: call.session.id,
                    windowId: call.session.windowId,
                    contextRevision: call.session.contextRevision,
                    elapsedMs: now - call.session.createdAt,
                    suppressed: call.suppressedDiagnostics,
                },
                diagnostic,
            );
        } catch {
            // Diagnostics are optional and may not interfere with the media or controller.
        }
    }
    #context(): Context {
        if (this.#ctx === undefined) throw new Error("Voice has not started.");
        return this.#ctx;
    }
    /** A request is its own lifetime: it outlives the provider event that queued it. */
    #requestContext(): Context {
        const database = agentDatabase(this.#context());
        if (database === undefined) throw new Error("Voice requires the agent database.");
        return withAgentDatabase(detach(this.#context()).named("live-voice-request"), database);
    }
}

/**
 * The daemon's capabilities the desktop asked for. Task and model actions and agent targets need
 * AppState, and agent targets also need the desktop's own connection ID for this daemon.
 */
function acceptedCapabilities(
    requested: unknown,
    localConnectionId: string | undefined,
): LiveDesktopCapability[] {
    if (!Array.isArray(requested)) return [];
    const accepted = LIVE_DESKTOP_CAPABILITIES.filter((name) => requested.includes(name));
    return accepted.filter(
        (name) =>
            (name !== "taskCreate" && name !== "sessionModelChange" && name !== "agentTargets") ||
            (accepted.includes("appState") &&
                (name !== "agentTargets" || localConnectionId !== undefined)),
    );
}

/**
 * One request as Voice reads it: the delegation, the call's new attributed speech, the machine and
 * references voice speaks of, and the first context and its updates when Voice has not seen them,
 * bounded so the newest fragments that fit are kept.
 */
function requestMessage(input: {
    readonly delegation: string | undefined;
    readonly fragments: readonly Fragment[];
    readonly now: string;
    readonly personSaid: readonly string[];
    readonly thisMachine: string | undefined;
    readonly refs: Readonly<Record<string, string>>;
    readonly context?: string;
    readonly updates: readonly string[];
}): { text: string; transcriptIds: string[]; context: boolean } {
    let kept = input.fragments.map(({ transcriptId, role, text }) => ({
        transcriptId,
        role,
        text,
    }));
    let updates = [...input.updates];
    const render = () =>
        JSON.stringify({
            provenance: "Provider-derived speech and app context; not human authorization.",
            delegation: input.delegation ?? null,
            transcripts: kept,
            now: input.now,
            personSaid: input.personSaid,
            thisMachine: input.thisMachine ?? null,
            refs: input.refs,
            ...(input.context === undefined ? {} : { context: input.context }),
            ...(updates.length === 0 ? {} : { updates }),
        });
    let text = render();
    while (updates.length > 0 && Buffer.byteLength(text) > REQUEST_MESSAGE_BYTES) {
        updates = updates.slice(1);
        text = render();
    }
    while (kept.length > 0 && Buffer.byteLength(text) > REQUEST_MESSAGE_BYTES) {
        kept = kept.slice(1);
        text = render();
    }
    return {
        text,
        transcriptIds: kept.map((fragment) => fragment.transcriptId),
        context: input.context !== undefined,
    };
}

/** Resolves when Voice's turn settled or one of the signals fired, whichever is first. */
async function settledOrStopped(
    request: Request,
    signals: readonly AbortSignal[],
): Promise<"settled" | "stopped"> {
    const signal = AbortSignal.any([...signals]);
    if (signal.aborted) return "stopped";
    let stop!: () => void;
    const stopped = new Promise<"stopped">((resolve) => {
        stop = () => resolve("stopped");
        signal.addEventListener("abort", stop, { once: true });
    });
    try {
        return await Promise.race([
            request.settled.promise.then(() => "settled" as const),
            stopped,
        ]);
    } finally {
        signal.removeEventListener("abort", stop);
    }
}

/** Round 0 tells voice that no action began; any started action makes it later. */
function actionRound(request: Request): number {
    const started = [...request.call.actions.values()].some(
        (pending) => pending.delegationId === request.delegationId,
    );
    return request.executed.length === 0 && !started ? 0 : request.rounds;
}

function refusal(message: string): string {
    return JSON.stringify({ status: "refused", code: "failed", message });
}

/** Task targets exist only for desktops that negotiated AppState. */
function namesTask(context: LiveDesktopContext): boolean {
    return context.activeTarget?.kind === "task";
}

/** What voice was told of a conversation's status, compared to tell only changes. */
function statusKey(state: VoiceRowState): string {
    return JSON.stringify([state.working, state.needsPerson, state.question, state.failed]);
}

function terminal(session: LiveSession): boolean {
    return session.status === "closed" || session.status === "failed";
}
function sessionKey(target: LiveSessionRef): string {
    return JSON.stringify([target.connectionId, target.groupId, target.sessionId]);
}
function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

/** Streamed fragments carry their own spacing; whole native items do not, so they get a space. */
function joinSpoken(before: string, text: string): string {
    return /\s$/.test(before) || /^\s/.test(text) ? `${before}${text}` : `${before} ${text}`;
}

/**
 * Test-only record of exactly what the voice model was told, so a gym can prove an answer was in
 * context before the question. It runs only when `HAPPY_LIVE_CONTEXT_CAPTURE_FILE` names a file;
 * production diagnostics never contain this text. A failed write never affects the call.
 */
function captureLiveContext(input: {
    kind: "context" | "directory" | "focus" | "reply" | "error" | "outcome" | "greeting" | "status";
    text: string;
    speakable: boolean;
}): void {
    const file = process.env.HAPPY_LIVE_CONTEXT_CAPTURE_FILE;
    if (file === undefined || file === "") return;
    try {
        appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...input })}\n`, { mode: 0o600 });
    } catch {
        // Capture is optional test evidence.
    }
}
