import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import {
    createLiveSessionRequestSchema,
    liveControlClientMessageSchema,
    liveControlServerMessageSchema,
    type CreateLiveSessionRequest,
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
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, shutdown, type Context } from "@steve.kite/stdlib";
import { ConfigModule, VoiceCredentialPoolError } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
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
import { LIVE_VOICE_INSTRUCTIONS } from "./impl/livePrompts.js";
import { runLiveController } from "./impl/runLiveController.js";
import {
    createLiveProviderTransport,
    LiveProviderError,
    type LiveProviderEvent,
} from "./impl/liveProviderTransport.js";

const FRAME_BYTES = 256 * 1024;
const START = "live-start-once";
type Transport = Awaited<ReturnType<typeof createLiveProviderTransport>>;
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
    action: LiveDesktopAction;
    result?: LiveDesktopActionResult;
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
    abort: AbortController;
    controllerAbort: AbortController;
    allocated: ReturnType<typeof deferred<string>>;
    transport?: Transport;
    socket?: LiveControlSocket;
    claimed: boolean;
    controllerLost?: true;
    attachTimer?: ReturnType<typeof setTimeout>;
    queue: Promise<void>;
    queued: number;
    queuedBytes: number;
    fragments: Extract<LiveControlServerMessage, { type: "transcript" }>[];
    actions: Map<string, ActionState>;
    watched: Set<string>;
    updates: Map<string, Extract<LiveControlClientMessage, { type: "sessionUpdate" }>>;
    delegations: Set<string>;
    controllerBusy: boolean;
}

/** One window-scoped feature owns its persistence, provider call, control socket and side inference. */
export class LiveModule implements AgentModule {
    readonly name = "live";
    readonly migrations = liveMigrations;
    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #calls = new Map<string, Call>();
    readonly #listeners = new Set<(event: LiveEvent) => void>();
    #ctx: Context | undefined;
    #stopped = false;

    constructor(config: ConfigModule, durable: DurableFunctionsModule) {
        this.#config = config;
        this.#durable = durable;
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

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Voice requires the agent database.");
        this.#ctx = withAgentDatabase(detach(ctx).named("live-sessions"), database);
        shutdown.get(ctx)?.register("live", async () => await this.stop());
        await ctx.inTx(async (tx) => {
            for (const { ownerId, session } of await activeLiveSessions(tx)) {
                await this.#update(tx, ownerId, session, {
                    status: "failed",
                    error: "Voice ended because the daemon restarted. Start a new call explicitly.",
                    endedAt: Date.now(),
                    usage: { seconds: session.usage.seconds, final: false },
                });
            }
        });
        return {};
    };

    onEvent(listener: (event: LiveEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Returns an allocation barrier, without waiting for external work in the caller's transaction. */
    async reserve(
        ctx: Context,
        ownerId: string,
        request: CreateLiveSessionRequest,
    ): Promise<{ session: LiveSession; allocated: Promise<string> }> {
        if (
            !Value.Check(createLiveSessionRequestSchema, request) ||
            request.windowId !== request.context.windowId ||
            Buffer.byteLength(
                JSON.stringify({
                    type: "desktopContext",
                    revision: request.contextRevision,
                    context: request.context,
                }),
            ) > FRAME_BYTES
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
            route = await this.#config.liveControllerRoute();
        } catch {
            throw new LiveError(
                503,
                "live_unavailable",
                "Voice cannot use the default controller model. Check the enabled default model and its accounts.",
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
            const call: Call = {
                ownerId,
                session,
                context: structuredClone(request.context),
                request: structuredClone(request),
                route,
                credential,
                abort: new AbortController(),
                controllerAbort: new AbortController(),
                allocated: deferred<string>(),
                claimed: false,
                queue: Promise.resolve(),
                queued: 0,
                queuedBytes: 0,
                fragments: [],
                actions: new Map(),
                watched: new Set(),
                updates: new Map(),
                delegations: new Set(),
                controllerBusy: false,
            };
            // Observe rejection even when an outer transaction rolls back or the HTTP caller leaves.
            void call.allocated.promise.catch(() => undefined);
            afterCommit(tx, () => {
                this.#calls.set(id, call);
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
                clearTimeout(call.attachTimer);
                this.#send(call, {
                    type: "hello",
                    sessionId: id,
                    windowId,
                    contextRevision: call.session.contextRevision,
                });
                this.#send(call, {
                    type: "status",
                    status: call.session.status,
                    error: call.session.error,
                });
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
        await Promise.all(
            [...this.#calls.values()].map(async (call) => {
                await this.close(this.#context(), call.ownerId, call.session.id);
                await call.transport?.close();
                await call.queue;
            }),
        );
    }

    async #start(call: Call): Promise<void> {
        try {
            call.transport = await createLiveProviderTransport({
                credential: call.credential,
                sdp: call.request.sdp,
                instructions: LIVE_VOICE_INSTRUCTIONS,
                signal: call.abort.signal,
                onEvent: (event) =>
                    this.#enqueue(call, Buffer.byteLength(JSON.stringify(event)), () =>
                        this.#providerEvent(call, event),
                    ),
            });
            call.request.sdp = "";
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
            if (call.session.status === "starting") await this.#change(call, { status: "active" });
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
            const fragment: Extract<LiveControlServerMessage, { type: "transcript" }> = {
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
            while (
                call.fragments.length > 32 ||
                Buffer.byteLength(JSON.stringify(call.fragments)) > 65536
            )
                call.fragments.shift();
            this.#send(call, fragment);
        } else if (event.type === "delegation") {
            if (call.session.status !== "active" || call.socket === undefined)
                throw new Error("Voice requested an action before the desktop was ready.");
            if (call.delegations.has(event.delegationId)) return;
            if (call.delegations.size >= 256)
                throw new Error("Voice exceeded its bounded delegation capacity.");
            call.delegations.add(event.delegationId);
            if (call.controllerBusy) {
                await call.transport
                    ?.append({
                        delegationId: event.delegationId,
                        text: "The desktop controller is busy with the previous request. Ask again when it finishes.",
                        speakable: call.credential.type === "codex_subscription",
                    })
                    .catch(() => undefined);
                return;
            }
            call.controllerBusy = true;
            const fragments = [...call.fragments];
            void runLiveController(detach(this.#context()).named("live-desktop-delegation"), {
                provider: call.route.provider,
                model: call.route.model.id,
                effort: call.route.model.defaultEffort,
                signal: AbortSignal.any([call.controllerAbort.signal, call.route.signal]),
                context: structuredClone(call.context),
                fragments,
                sessionUpdates: [...call.updates.values()],
                ...(event.text === undefined ? {} : { delegationText: event.text }),
                execute: (action) =>
                    this.#action(
                        call,
                        action,
                        fragments.map((fragment) => fragment.transcriptId),
                    ),
            })
                .then(async (text) => {
                    if (!terminal(call.session) && call.session.status === "active")
                        await call.transport?.append({
                            delegationId: event.delegationId,
                            text: text || "The desktop request has completed.",
                            speakable: true,
                        });
                })
                .catch(async () => {
                    if (call.session.status === "active")
                        await this.#fail(
                            call,
                            "The voice controller could not safely complete the request. No uncertain action was retried.",
                        );
                })
                .finally(() => {
                    call.controllerBusy = false;
                });
        }
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
            call.context = message.context;
            const activeKey =
                message.context.activeSession === null
                    ? undefined
                    : sessionKey(message.context.activeSession.target);
            for (const key of call.updates.keys())
                if (key !== activeKey && !call.watched.has(key)) call.updates.delete(key);
            await this.#change(call, { contextRevision: message.revision });
        } else if (message.type === "actionResult") {
            const pending = call.actions.get(message.actionId);
            if (pending === undefined) throw new Error("The desktop answered an unknown action.");
            if (pending.result !== undefined) {
                if (!Value.Equal(pending.result, message.result))
                    throw new Error("The desktop changed a completed action result.");
                return;
            }
            if (message.result.status === "pending") {
                if (pending.action.type === "sessionSend")
                    throw new Error(
                        "Message staging cannot wait for human confirmation as a pending action.",
                    );
                return;
            }
            if (message.result.status === "succeeded") {
                if (
                    (message.result.output.type === "staged") !==
                    (pending.action.type === "sessionSend")
                )
                    throw new Error("The desktop returned an invalid staging result.");
                if (pending.action.type === "sessionWatch") {
                    const key = sessionKey(pending.action.target);
                    if (pending.action.enabled) call.watched.add(key);
                    else {
                        call.watched.delete(key);
                        if (
                            call.context.activeSession === null ||
                            sessionKey(call.context.activeSession.target) !== key
                        )
                            call.updates.delete(key);
                    }
                }
            }
            clearTimeout(pending.timer);
            pending.result = message.result;
            pending.resolve(message.result);
        } else {
            const key = sessionKey(message.target);
            if (
                key !==
                    (call.context.activeSession === null
                        ? undefined
                        : sessionKey(call.context.activeSession.target)) &&
                !call.watched.has(key)
            )
                throw new Error("The desktop updated an unselected conversation.");
            if (
                !call.context.sessions.some((item) => sessionKey(item.target) === key) &&
                !call.context.bots.some((item) => sessionKey(item.target) === key) &&
                (call.context.activeSession === null ||
                    sessionKey(call.context.activeSession.target) !== key)
            )
                throw new Error("The desktop updated an inaccessible conversation.");
            const previous = call.updates.get(key);
            if (previous !== undefined && Value.Equal(previous, message)) return;
            const priorStatus =
                previous?.status ??
                (call.context.activeSession !== null &&
                sessionKey(call.context.activeSession.target) === key
                    ? call.context.activeSession.status
                    : undefined);
            call.updates.set(key, message);
            if (
                call.updates.size > 6 ||
                Buffer.byteLength(JSON.stringify([...call.updates.values()])) > 128 * 1024
            )
                throw new Error("Voice exceeded its selected conversation context limit.");
            const speakable =
                message.status !== priorStatus &&
                (message.status === "error" ||
                    message.status === "awaitingInput" ||
                    (message.status === "idle" &&
                        (priorStatus === "running" || priorStatus === "waiting")));
            if (message.status === priorStatus) return;
            const title =
                call.context.sessions.find((item) => sessionKey(item.target) === key)?.title ??
                call.context.bots.find((item) => sessionKey(item.target) === key)?.name;
            const lastAssistant = message.messages.findLast((item) => item.role === "assistant");
            await call.transport
                ?.append({
                    delegationId: null,
                    text: JSON.stringify({
                        title: title?.slice(0, 256) ?? "Selected conversation",
                        status: message.status,
                        lastAssistantMessage: lastAssistant?.text.slice(0, 1600) ?? null,
                    }),
                    speakable,
                })
                .catch(() => undefined);
        }
    }

    async #action(
        call: Call,
        action: LiveDesktopAction,
        inputTranscriptIds: string[],
    ): Promise<LiveDesktopActionResult> {
        if (
            terminal(call.session) ||
            call.session.status !== "active" ||
            call.socket === undefined ||
            call.actions.size >= 256
        )
            throw new Error("Voice cannot start another desktop action.");
        if (
            action.type === "sessionWatch" &&
            action.enabled &&
            !call.watched.has(sessionKey(action.target)) &&
            call.watched.size >= 5
        )
            return {
                status: "refused",
                code: "unavailable",
                message: "At most five conversations can be watched.",
            };
        const actionId = createId();
        const result = deferred<LiveDesktopActionResult>();
        const timer = setTimeout(() => {
            result.reject(new Error("The desktop action timed out; its outcome is uncertain."));
            void this.#fail(
                call,
                "A desktop action timed out. Its outcome is uncertain and it was not retried.",
            );
        }, 60_000);
        timer.unref();
        call.actions.set(actionId, { action, resolve: result.resolve, timer });
        this.#send(call, {
            type: "actionRequested",
            actionId,
            contextRevision: call.session.contextRevision,
            inputTranscriptIds,
            action,
        });
        return await result.promise;
    }

    #enqueue(call: Call, bytes: number, work: () => Promise<void>): void {
        if (terminal(call.session)) return;
        if (++call.queued > 64 || (call.queuedBytes += bytes) > 1024 * 1024) {
            void this.#fail(call, "Voice exceeded its control queue limit.");
            return;
        }
        call.queue = call.queue
            .then(work)
            .catch(() =>
                this.#fail(
                    call,
                    "Voice received invalid or conflicting control data and ended safely.",
                ),
            )
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
                this.#send(call, { type: "status", status: session.status, error: session.error });
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

    async #fail(call: Call, error: string, providerError?: LiveProviderError): Promise<void> {
        if (!terminal(call.session))
            await this.#change(call, { status: "failed", error, endedAt: Date.now() });
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
        clearTimeout(call.attachTimer);
        this.#cancelActions(call);
        call.abort.abort();
        call.controllerAbort.abort();
        call.transport?.dispose();
        call.socket?.close(1000, "Voice has ended.");
        this.#calls.delete(call.session.id);
    }
    #emit(event: LiveEvent): void {
        for (const listener of this.#listeners) listener(event);
    }
    #context(): Context {
        if (this.#ctx === undefined) throw new Error("Voice has not started.");
        return this.#ctx;
    }
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
