import type * as acp from "@agentclientprotocol/sdk";
import type { Context } from "@steve.kite/stdlib";

import { BaseSession } from "@/core/BaseSession.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import type {
    AcpConfigOptionValue,
    AcpPermissionAnswer,
    AcpProviderOptions,
    AcpTurnEnvironment,
} from "@/protocol/acp/AcpProvider.js";
import { acpCompactWithAgent } from "@/protocol/acp/impl/acpCompactWithAgent.js";
import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import {
    acpCatchUpPrompt,
    acpPromptFromMessages,
    acpReplayPrompt,
} from "@/protocol/acp/impl/acpPromptFromMessages.js";
import { ACP_BRIDGE_NAME, AcpResponseEvents } from "@/protocol/acp/impl/acpResponseEvents.js";
import {
    acpSessionRecordClear,
    acpSessionRecordRead,
    acpSessionRecordWrite,
    acpTranscriptFingerprint,
    type AcpSessionRecord,
} from "@/protocol/acp/impl/acpSessionStore.js";
import {
    acpBridgeResult,
    AcpToolBridgeServer,
    type AcpBridgeCall,
} from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import { AcpTurnQueue } from "@/protocol/acp/impl/AcpTurnQueue.js";
import { acpAcceptsConfigValue, acpConfigOptionId } from "@/protocol/acp/impl/acpConfigOptions.js";

export interface AcpSessionOptions extends AcpProviderOptions {
    readonly instructions: string;
    readonly tools: readonly SessionTool[];
}

const PREVIOUS_PROMPT_GRACE_MS = 10_000;
/** How long a cancelled agent gets to end its prompt and save its session before it is stopped. */
const CANCEL_GRACE_MS = 2_000;
/**
 * Waits before sending a prompt the agent's service refused as too many requests again. Agents
 * retry only briefly themselves, and a burst — a restarted agent's first request, or several
 * sessions on one account at once — clears within seconds.
 */
const RATE_LIMIT_RETRY_MS = [3_000, 10_000, 30_000];
/** The most of an ask's raw input shown to the person, in characters. */
const MAX_ACTION_INPUT = 50_000;
const ABORTED = Symbol("acp_aborted");
const STEERED = Symbol("acp_steered");

type TurnItem =
    | { readonly kind: "update"; readonly update: acp.SessionUpdate }
    | { readonly kind: "bridge_call"; readonly call: AcpBridgeCall }
    | { readonly kind: "prompt_end"; readonly response: acp.PromptResponse }
    | { readonly kind: "prompt_error"; readonly error: unknown };

/**
 * One foreign prompt in flight. It outlives a Happy response whenever the agent calls a bridged
 * Happy tool: the response ends with that call, Agent Base executes it, and the next run answers
 * the still-open MCP request and keeps draining this same prompt.
 */
interface LiveTurn {
    readonly items: AcpTurnQueue<TurnItem>;
    /** Bridged calls handed to the caller whose results have not arrived yet. */
    readonly awaiting: Map<string, AcpBridgeCall>;
    /** Input that arrived while the prompt was still open; sent as the next prompt. */
    readonly deferred: SessionMessage[];
    /**
     * The Happy response ended for steering while this prompt kept running. The next run hands
     * the steering to the agent's own loop and keeps draining this prompt.
     */
    steering: boolean;
    /**
     * The read a response left waiting when steering or an abort won the race. The next response
     * takes it over, so the item it receives is not lost.
     */
    reading: Promise<TurnItem> | undefined;
    /** The prompt last sent, so one the service refused can be sent again. */
    sent: acp.ContentBlock[] | undefined;
}

/**
 * A Happy conversation continued inside a foreign agent's own ACP session.
 *
 * Each run sends only the input the foreign session has not seen yet. When the foreign session
 * cannot be continued — it was lost, or Happy's transcript no longer matches what it saw — a new
 * one is opened and given Happy's instructions and transcript to continue from.
 */
export class AcpSession extends BaseSession {
    readonly #options: AcpSessionOptions;
    readonly #bridgedTools: readonly SessionTool[];
    #connection: AcpConnection | undefined;
    #connecting: Promise<AcpConnection> | undefined;
    #acpSessionId: string | undefined;
    #cwd: string | undefined;
    #record: AcpSessionRecord | undefined;
    #recordLoaded = false;
    /**
     * The foreign session known to keep what it was sent: one that answered a prompt, or one
     * restored from a stored record. An agent may save a new session only once it ends a prompt,
     * so a session stopped before answering its first one may come back empty. Until a session is
     * known here, where it stands is kept in memory only and is dropped when its agent stops.
     */
    #keptSessionId: string | undefined;
    #turn: LiveTurn | undefined;
    #previousPrompt: Promise<unknown> = Promise.resolve();
    /** Settles once a stopped agent process has exited, so its successor never overlaps it. */
    #stopping: Promise<void> = Promise.resolve();
    #replaying = false;
    /** What the latest run was given: its permission mode and how to reach the person. */
    #environment: AcpTurnEnvironment | undefined;
    #runCtx: Context | undefined;
    /** Questions put to the person that the agent is still waiting on. */
    readonly #asks = new Set<AbortController>();
    #bridge: AcpToolBridgeServer | undefined;
    readonly #applied = new Map<string, string | boolean>();
    /** The configuration options the foreign session last advertised. */
    #advertised: acp.SessionConfigOption[] | undefined;
    readonly #closedCalls = new Set<string>();
    #contextUsed = 0;
    #destroyed = false;

    constructor(id: string, options: AcpSessionOptions) {
        super(id);
        this.#options = options;
        // Provider-owned server tools stay with the provider that owns them.
        this.#bridgedTools = options.tools.filter((tool) => tool.server === undefined);
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        // A consumer stops a response by returning its iterator. An async generator only honors
        // that at its next `yield`, and a foreign agent can stay silent for minutes inside its own
        // command, so returning also signals the turn directly.
        const stopped = new AbortController();
        const lifetime =
            ctx.lifetime === undefined
                ? stopped.signal
                : AbortSignal.any([ctx.lifetime, stopped.signal]);
        const inner = this.#stream(ctx, lifetime, request);
        return {
            [Symbol.asyncIterator]: () => ({
                next: () => inner.next(),
                return: async (value?: unknown) => {
                    stopped.abort();
                    return await inner.return(value as undefined);
                },
            }),
        };
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const result = await acpCompactWithAgent(ctx, options, (runCtx, request) =>
            this.#stream(runCtx, runCtx.lifetime, request),
        );
        if (result.status === "completed") {
            // The foreign session still holds the long context; the next run opens a new one
            // from the summary instead.
            this.#acpSessionId = undefined;
            this.#record = undefined;
        } else {
            this.#abandonTurn();
        }
        return result;
    }

    destroy(): void {
        this.#destroyed = true;
        this.#abandonTurn();
        this.#bridge?.close();
        this.#bridge = undefined;
        const connection = this.#connection;
        this.#connection = undefined;
        this.#connecting = undefined;
        connection?.terminate();
    }

    async *#stream(
        ctx: Context,
        signal: AbortSignal | undefined,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        if (signal?.aborted) {
            yield { type: "done", state: "cancelled" };
            return;
        }
        const environment = this.#options.environment(ctx);
        this.#environment = environment;
        this.#runCtx = ctx;
        yield { type: "block_start" };

        let connection: AcpConnection | undefined;
        let turn: LiveTurn;
        try {
            connection = await this.#connect(environment);
            await this.#loadRecord();
            const live = this.#turn;
            if (
                live !== undefined &&
                (live.awaiting.size > 0 || live.steering) &&
                this.#acpSessionId !== undefined
            ) {
                turn = live;
                await this.#continueTurn(connection, turn, request.context.messages);
            } else {
                this.#abandonTurn();
                await settleWithin(this.#previousPrompt, PREVIOUS_PROMPT_GRACE_MS);
                const prompt = await this.#prepareSession(ctx, connection, environment, request);
                await this.#applyOptions(connection, request, environment);
                turn = this.#startTurn(connection, prompt);
            }
        } catch (error) {
            yield { type: "block_stop" };
            yield errorDone(error, connection?.stderr() ?? "");
            return;
        }

        const events = new AcpResponseEvents(this.#closedCalls);
        const aborted = abortPromise(signal);
        // Steering ends this response so Agent Base can deliver the new input on the next run.
        const steered = abortPromise(request.steered).then((): typeof STEERED => STEERED);
        let finished = false;
        let retries = 0;
        // Anything the agent reported — text, reasoning, its own tool calls — means it acted on
        // the prompt, and sending it again could repeat that work.
        let reported = false;
        try {
            for (;;) {
                turn.reading ??= turn.items.next();
                const item = await Promise.race([turn.reading, aborted, steered]);
                if (item !== ABORTED && item !== STEERED) turn.reading = undefined;
                if (item === STEERED) {
                    yield* events.close();
                    yield* events.settleAll();
                    await this.#commit(request.context.messages);
                    // An agent whose loop takes input mid-turn keeps going; the steering joins it
                    // on the next run. Any other agent is interrupted.
                    if (connection.conn.steer !== undefined) turn.steering = true;
                    else this.#stopTurn(connection);
                    finished = true;
                    const usage = this.#usage(undefined, events.outputCharacters);
                    yield { type: "token_usage", usage };
                    yield { type: "block_stop" };
                    yield {
                        type: "done",
                        state: "normal",
                        tokens: { input: usage.input, output: usage.output },
                    };
                    return;
                }
                // A consumer stops reading at `done`, so everything that must happen for a turn
                // happens before that event is yielded.
                if (item === ABORTED) {
                    yield* events.close();
                    yield* events.settleAll();
                    // The agent already saw this turn's input, so the next run sends only what is
                    // new rather than repeating a request the user stopped.
                    await this.#commit(request.context.messages);
                    this.#stopTurn(connection);
                    finished = true;
                    yield { type: "block_stop" };
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                if (item.kind === "update") {
                    reported = true;
                    yield* events.update(item.update);
                    continue;
                }
                if (item.kind === "prompt_end" && turn.deferred.length > 0) {
                    const next = turn.deferred.splice(0);
                    this.#sendPrompt(
                        connection,
                        turn,
                        acpPromptFromMessages(next, images(connection)),
                    );
                    continue;
                }
                yield* events.close();
                yield* events.settleAll();
                if (item.kind === "prompt_error") {
                    const wait = RATE_LIMIT_RETRY_MS[retries];
                    if (
                        wait !== undefined &&
                        turn.sent !== undefined &&
                        isRateLimited(item.error) &&
                        !reported &&
                        turn.awaiting.size === 0 &&
                        this.#connection === connection &&
                        this.#turn === turn
                    ) {
                        // Refused before saying anything: the same prompt, a little later.
                        retries++;
                        yield { type: "retrying", attempt: retries, reason: errorText(item.error) };
                        let timer: NodeJS.Timeout | undefined;
                        const waited = await Promise.race([
                            new Promise<void>((resolve) => (timer = setTimeout(resolve, wait))),
                            aborted,
                            steered,
                        ]).finally(() => clearTimeout(timer));
                        if (waited !== ABORTED && waited !== STEERED) {
                            this.#sendPrompt(connection, turn, turn.sent);
                            continue;
                        }
                        this.#turn = undefined;
                        finished = true;
                        yield { type: "block_stop" };
                        if (waited === ABORTED) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        // The agent never took the refused prompt, so nothing is recorded as
                        // seen: the next run sends it together with the steering, once.
                        yield { type: "done", state: "normal", tokens: { input: 0, output: 0 } };
                        return;
                    }
                    this.#turn = undefined;
                    finished = true;
                    yield { type: "block_stop" };
                    yield errorDone(item.error, connection.stderr());
                    return;
                }
                if (item.kind === "bridge_call") {
                    const { call } = item;
                    turn.awaiting.set(call.callId, call);
                    yield {
                        type: "toolcall_start",
                        callId: call.callId,
                        name: call.tool.name,
                        ...(call.tool.namespace === undefined
                            ? {}
                            : { namespace: call.tool.namespace }),
                    };
                    yield { type: "toolcall_end", callId: call.callId, arguments: call.arguments };
                }
                const response = item.kind === "prompt_end" ? item.response : undefined;
                if (response !== undefined) this.#turn = undefined;
                const usage = this.#usage(response, events.outputCharacters);
                const tokens = { input: usage.input, output: usage.output };
                await this.#commit(request.context.messages);
                finished = true;
                yield { type: "token_usage", usage };
                yield { type: "block_stop" };
                if (response === undefined) {
                    yield { type: "done", state: "tool_call", tokens };
                } else if (response.stopReason === "cancelled") {
                    yield { type: "done", state: "cancelled" };
                } else if (
                    response.stopReason === "max_tokens" ||
                    response.stopReason === "max_turn_requests"
                ) {
                    yield { type: "done", state: "length", tokens };
                } else {
                    yield { type: "done", state: "normal", tokens, endTurn: true };
                }
                return;
            }
        } finally {
            // A consumer that stopped reading mid-turn stopped it: this is how Agent Base aborts.
            if (!finished) {
                void this.#commit(request.context.messages).catch(() => undefined);
                this.#stopTurn(connection);
            }
        }
    }

    /**
     * Continue a prompt that outlived the last Happy response: answer its open MCP requests with
     * the results Agent Base produced, and hand any new input to the agent's loop when it takes
     * input mid-turn, or keep it for the next prompt when it does not.
     */
    async #continueTurn(
        connection: AcpConnection,
        turn: LiveTurn,
        messages: readonly SessionMessage[],
    ): Promise<void> {
        turn.steering = false;
        const input: SessionMessage[] = [];
        for (const message of inputMessages(messages).slice(this.#record?.consumed ?? 0)) {
            const call = message.role === "tool" ? turn.awaiting.get(message.callId) : undefined;
            if (call !== undefined && message.role === "tool") {
                turn.awaiting.delete(message.callId);
                call.resolve(acpBridgeResult(message));
            } else {
                input.push(message);
            }
        }
        const steer = connection.conn.steer;
        const taken =
            input.length > 0 &&
            steer !== undefined &&
            (await steer
                .call(connection.conn, {
                    sessionId: this.#acpSessionId!,
                    prompt: acpPromptFromMessages(input, images(connection)),
                })
                .catch(() => false));
        if (!taken) turn.deferred.push(...input);
        for (const call of turn.awaiting.values()) {
            call.resolve({
                content: [{ type: "text", text: "No result was recorded for this call." }],
                isError: true,
            });
        }
        turn.awaiting.clear();
    }

    async #connect(environment: AcpTurnEnvironment): Promise<AcpConnection> {
        if (this.#destroyed) throw new Error("The agent session was closed.");
        if (this.#connection !== undefined) return this.#connection;
        await this.#stopping;
        if (this.#connection !== undefined) return this.#connection;
        const { connect, launch } = this.#options;
        this.#connecting ??= (
            connect === undefined
                ? acpConnectionSpawn(launch!, environment.cwd, this.#client())
                : connect(environment.cwd, this.#client())
        ).then(
            (connection) => {
                this.#connecting = undefined;
                // Closed while the agent was starting: nothing will ever end it but this.
                if (this.#destroyed) {
                    connection.terminate();
                    throw new Error("The agent session was closed.");
                }
                this.#connection = connection;
                void connection.exited.then((error) => {
                    // A stopped agent was already detached; its exit belongs to no current turn.
                    if (this.#connection !== connection) return;
                    this.#turn?.items.push({ kind: "prompt_error", error });
                    this.#connection = undefined;
                    this.#acpSessionId = undefined;
                    this.#applied.clear();
                    this.#forgetUnkeptRecord();
                });
                return connection;
            },
            (error: unknown) => {
                this.#connecting = undefined;
                throw error;
            },
        );
        return await this.#connecting;
    }

    #client(): acp.Client {
        return {
            requestPermission: async (params) => this.#answerPermission(params),
            sessionUpdate: async (params) => {
                if (this.#replaying || params.sessionId !== this.#acpSessionId) return;
                if (params.update.sessionUpdate === "config_option_update") {
                    this.#advertised = params.update.configOptions;
                }
                if (params.update.sessionUpdate === "usage_update") {
                    this.#contextUsed = params.update.used;
                }
                this.#turn?.items.push({ kind: "update", update: params.update });
            },
        };
    }

    async #loadRecord(): Promise<void> {
        if (this.#recordLoaded) return;
        this.#record = await acpSessionRecordRead(this.#options.stateDirectory, this.id);
        this.#recordLoaded = true;
    }

    /** Open, restore, or keep the foreign session, and return the prompt this run sends. */
    async #prepareSession(
        ctx: Context,
        connection: AcpConnection,
        environment: AcpTurnEnvironment,
        request: SessionRunRequest,
    ): Promise<acp.ContentBlock[]> {
        const messages = request.context.messages;
        const inputs = inputMessages(messages);
        const record = this.#record;
        const continues =
            record !== undefined &&
            record.cwd === environment.cwd &&
            record.consumed <= inputs.length &&
            acpTranscriptFingerprint(inputs.slice(0, record.consumed)) === record.fingerprint;
        if (continues) {
            const delta = acpDeltaPrompt(messages, record.consumed, images(connection));
            if (this.#acpSessionId === record.acpSessionId && this.#cwd === environment.cwd) {
                return delta;
            }
            if (await this.#restoreSession(connection, record, environment)) return delta;
        }

        const response = await connection.conn.newSession({
            cwd: environment.cwd,
            mcpServers: await this.#mcpServers(connection),
            _meta: this.#sessionMeta(),
        } as acp.NewSessionRequest);
        this.#acpSessionId = response.sessionId;
        this.#advertised = response.configOptions ?? undefined;
        this.#cwd = environment.cwd;
        this.#applied.clear();
        this.#record = undefined;
        // The replaced session must not be continued by a later process before this one is kept.
        await acpSessionRecordClear(this.#options.stateDirectory, this.id, ctx);
        let lastResponse = -1;
        messages.forEach((message, index) => {
            if (message.role === "assistant") lastResponse = index;
        });
        return acpReplayPrompt(
            request.context.instructions,
            messages.slice(0, lastResponse + 1),
            messages.slice(lastResponse + 1),
            images(connection),
        );
    }

    async #restoreSession(
        connection: AcpConnection,
        record: AcpSessionRecord,
        environment: AcpTurnEnvironment,
    ): Promise<boolean> {
        const capabilities = connection.init.agentCapabilities;
        const params = {
            sessionId: record.acpSessionId,
            cwd: environment.cwd,
            mcpServers: await this.#mcpServers(connection),
            _meta: this.#sessionMeta(),
        };
        try {
            if (capabilities?.sessionCapabilities?.resume != null) {
                const resumed = await connection.conn.resumeSession(
                    params as acp.ResumeSessionRequest,
                );
                this.#advertised = resumed.configOptions ?? undefined;
            } else if (capabilities?.loadSession === true) {
                // Loading replays the whole history as notifications; Happy already has it.
                this.#replaying = true;
                try {
                    const loaded = await connection.conn.loadSession(
                        params as acp.LoadSessionRequest,
                    );
                    this.#advertised = loaded.configOptions ?? undefined;
                } finally {
                    this.#replaying = false;
                }
            } else {
                return false;
            }
        } catch {
            return false;
        }
        this.#acpSessionId = record.acpSessionId;
        this.#keptSessionId = record.acpSessionId;
        this.#cwd = environment.cwd;
        this.#applied.clear();
        return true;
    }

    async #applyOptions(
        connection: AcpConnection,
        request: SessionRunRequest,
        environment: AcpTurnEnvironment,
    ): Promise<void> {
        const profile = this.#options.profile;
        const wanted: AcpConfigOptionValue[] = [
            ...(profile?.modelOptions?.(request.model, request.effort) ?? []),
            ...(environment.permissionMode === undefined
                ? []
                : (profile?.permissionOptions?.(environment.permissionMode) ?? [])),
        ];
        for (const option of wanted) {
            const configId = acpConfigOptionId(this.#advertised, option);
            if (configId === undefined) continue;
            if (this.#applied.get(configId) === option.value) continue;
            // A value the agent does not offer, such as a model it no longer serves, would fail
            // the whole turn; the agent keeps its current choice instead.
            if (!acpAcceptsConfigValue(this.#advertised, configId, option.value)) continue;
            const changed = await connection.conn.setSessionConfigOption({
                sessionId: this.#acpSessionId!,
                configId,
                ...(typeof option.value === "boolean"
                    ? { type: "boolean", value: option.value }
                    : { value: option.value }),
            } as acp.SetSessionConfigOptionRequest);
            this.#advertised = changed.configOptions;
            this.#applied.set(configId, option.value);
        }
    }

    async #mcpServers(connection: AcpConnection): Promise<acp.McpServer[]> {
        const bridge = await this.#ensureBridge();
        if (bridge === undefined) return [];
        if (connection.init.agentCapabilities?.mcpCapabilities?.http !== true) return [];
        return [
            {
                type: "http",
                name: ACP_BRIDGE_NAME,
                url: bridge.url,
                headers: Object.entries(bridge.headers).map(([name, value]) => ({ name, value })),
            },
        ];
    }

    /** The bridged tools the agent may call without asking: those no call of needs approval. */
    #sessionMeta(): Record<string, unknown> {
        return {
            [ACP_APPROVED_TOOLS_META]: this.#bridgedTools
                .filter((tool) => tool.autoReview === "never")
                .map((tool) => AcpToolBridgeServer.toolName(tool)),
        };
    }

    async #ensureBridge(): Promise<AcpToolBridgeServer | undefined> {
        if (this.#bridgedTools.length === 0) return undefined;
        this.#bridge ??= await AcpToolBridgeServer.start(this.#bridgedTools, (call) => {
            const turn = this.#turn;
            if (turn === undefined) {
                call.resolve({
                    content: [{ type: "text", text: "No Happy turn is active." }],
                    isError: true,
                });
                return;
            }
            turn.items.push({ kind: "bridge_call", call });
        });
        return this.#bridge;
    }

    #startTurn(connection: AcpConnection, prompt: acp.ContentBlock[]): LiveTurn {
        const turn: LiveTurn = {
            items: new AcpTurnQueue(),
            awaiting: new Map(),
            deferred: [],
            steering: false,
            reading: undefined,
            sent: undefined,
        };
        this.#turn = turn;
        this.#sendPrompt(connection, turn, prompt);
        return turn;
    }

    #sendPrompt(connection: AcpConnection, turn: LiveTurn, prompt: acp.ContentBlock[]): void {
        const sessionId = this.#acpSessionId!;
        turn.sent = prompt;
        this.#previousPrompt = connection.conn.prompt({ sessionId, prompt }).then(
            async (response) => {
                // An agent that answered a prompt has saved its session, so where this
                // conversation stands in it may now outlive the agent's process.
                //
                // Replay tradeoff: If an agent process was stopped or died before ending its first
                // prompt, the opening prompt will be replayed in a fresh session. The new session
                // may repeat external work (such as tool calls or mutations) that the previous dead
                // process began before hanging or stopping. This duplicate-work tradeoff is preferred
                // over silent loss of opening instructions.
                //
                // Prompts that complete with stopReason "cancelled" (via graceful prompt cancellation)
                // successfully resolve `send()` and therefore count as kept by design: the foreign agent
                // acknowledged and saved the session state before closing the turn.
                if (this.#keptSessionId !== sessionId) {
                    this.#keptSessionId = sessionId;
                    if (this.#record?.acpSessionId === sessionId) {
                        await this.#writeRecord(this.#record).catch(() => undefined);
                    }
                }
                // A prompt that ended waits on nothing it asked.
                if (this.#turn === turn) this.#withdrawAsks();
                turn.items.push({ kind: "prompt_end", response });
            },
            (error: unknown) => {
                if (this.#turn === turn) this.#withdrawAsks();
                turn.items.push({ kind: "prompt_error", error });
            },
        );
    }

    #cancelTurn(connection: AcpConnection): void {
        if (this.#turn === undefined) return;
        if (this.#acpSessionId !== undefined) {
            void connection.conn.cancel({ sessionId: this.#acpSessionId }).catch(() => undefined);
        }
        this.#abandonTurn();
    }

    /**
     * Stop means stopped: cancel the prompt, give the agent a moment to end it and save its
     * session, then end the agent and whatever it was still running. The next run starts a new
     * agent process and restores the same foreign session from the record.
     */
    #stopTurn(connection: AcpConnection): void {
        const prompt = this.#previousPrompt;
        // Taken before cancelling: an agent may orphan the command it was running as it cancels.
        const groups = connection.processGroups();
        this.#cancelTurn(connection);
        if (this.#connection === connection) {
            this.#connection = undefined;
            this.#acpSessionId = undefined;
            this.#applied.clear();
        }
        this.#stopping = settleWithin(prompt, CANCEL_GRACE_MS).then(async () => {
            connection.terminate(groups);
            await settleWithin(connection.exited, CANCEL_GRACE_MS);
            // A session stopped before it answered any prompt may never have been saved; the next
            // run opens a new one and replays the conversation rather than lose its start.
            this.#forgetUnkeptRecord();
        });
    }

    /** Drop where the conversation stands in a session its agent may not have kept. */
    #forgetUnkeptRecord(): void {
        if (this.#record !== undefined && this.#record.acpSessionId !== this.#keptSessionId) {
            this.#record = undefined;
        }
    }

    #withdrawAsks(): void {
        for (const ask of this.#asks) ask.abort();
        this.#asks.clear();
    }

    #abandonTurn(): void {
        // The agent stops waiting on what it asked; each open question is withdrawn.
        this.#withdrawAsks();
        const turn = this.#turn;
        this.#turn = undefined;
        if (turn === undefined) return;
        for (const call of turn.awaiting.values()) {
            call.resolve({
                content: [{ type: "text", text: "The Happy turn was cancelled." }],
                isError: true,
            });
        }
        turn.awaiting.clear();
    }

    async #commit(messages: readonly SessionMessage[]): Promise<void> {
        if (this.#acpSessionId === undefined || this.#cwd === undefined) return;
        const inputs = inputMessages(messages);
        this.#record = {
            acpSessionId: this.#acpSessionId,
            cwd: this.#cwd,
            consumed: inputs.length,
            fingerprint: acpTranscriptFingerprint(inputs),
        };
        // Stored once the agent is known to keep the session; until then it lives only here.
        if (this.#record.acpSessionId === this.#keptSessionId) {
            await this.#writeRecord(this.#record);
        }
    }

    async #writeRecord(record: AcpSessionRecord): Promise<void> {
        await acpSessionRecordWrite(this.#options.stateDirectory, this.id, record);
    }

    /**
     * The agent's own permission system asks before acting. Read only refuses and Full access
     * allows without asking anyone. Otherwise a call of a bridged Happy tool that its own rule says
     * needs no approval goes ahead in Workspace write, and everything else is put to the person.
     */
    async #answerPermission(
        params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
        const environment = this.#environment;
        const mode = environment?.permissionMode;
        if (mode === "read_only") return pick(params, "deny");
        if (mode === "full_access") {
            // Once when it can, else for the session: Full access never refuses for want of it.
            const once = params.options.some((option) => option.kind === "allow_once");
            return pick(params, once ? "allow_once" : "allow_for_session");
        }
        if (mode === "workspace_write" && (await this.#needsNoApproval(params))) {
            return pick(params, "allow_once");
        }
        const ask = environment?.askPermission;
        if (ask === undefined) return pick(params, "deny");
        // A stopped or finished turn has nobody to ask on its behalf.
        if (this.#turn === undefined) return pick(params, "cancelled");
        const withdrawn = new AbortController();
        this.#asks.add(withdrawn);
        try {
            const answer = await ask(
                {
                    action: permissionAction(params.toolCall),
                    allowForSession: params.options.some(
                        (option) => option.kind === "allow_always",
                    ),
                },
                withdrawn.signal,
            );
            return withdrawn.signal.aborted ? pick(params, "cancelled") : pick(params, answer);
        } catch {
            return pick(params, withdrawn.signal.aborted ? "cancelled" : "deny");
        } finally {
            this.#asks.delete(withdrawn);
        }
    }

    /** Whether the ask is about a bridged Happy tool call that its own rule lets through. */
    async #needsNoApproval(params: acp.RequestPermissionRequest): Promise<boolean> {
        const call = params.toolCall._meta?.[ACP_BRIDGED_CALL_META] as
            | { readonly name?: unknown; readonly arguments?: unknown }
            | undefined;
        const tool = this.#bridgedTools.find(
            (candidate) => AcpToolBridgeServer.toolName(candidate) === call?.name,
        );
        if (tool === undefined || this.#runCtx === undefined) return false;
        if (tool.autoReview === "never") return true;
        try {
            return (
                (await tool.shouldReviewInAutoMode?.(call?.arguments ?? {}, this.#runCtx)) === false
            );
        } catch {
            // A rule that cannot answer has not said the call is safe.
            return false;
        }
    }

    #usage(response: acp.PromptResponse | undefined, outputCharacters: number): SessionUsage {
        const reported = response?.usage ?? undefined;
        const output = reported?.outputTokens ?? Math.ceil(outputCharacters / 4);
        const input = this.#contextUsed > 0 ? this.#contextUsed : (reported?.inputTokens ?? 0);
        return {
            input,
            output,
            cacheRead: reported?.cachedReadTokens ?? 0,
            cacheWrite: reported?.cachedWriteTokens ?? 0,
            totalTokens: input + output,
        };
    }
}

/** Everything the foreign session consumes. Its own responses are never sent back to it. */
function inputMessages(messages: readonly SessionMessage[]): SessionMessage[] {
    return messages.filter((message) => message.role !== "assistant");
}

/**
 * What a continuing foreign session is sent: the input after the `consumed` it has seen. Its own
 * replies follow that input directly; a reply after any newer input came from somewhere else —
 * another account, harness or model the conversation was switched to — so everything up to the
 * last such reply is passed on as a transcript rather than lost.
 */
function acpDeltaPrompt(
    messages: readonly SessionMessage[],
    consumed: number,
    images: boolean,
): acp.ContentBlock[] {
    let start = 0;
    for (let seen = 0; start < messages.length && seen < consumed; start++) {
        if (messages[start]!.role !== "assistant") seen++;
    }
    while (start < messages.length && messages[start]!.role === "assistant") start++;
    const rest = messages.slice(start);
    const answered = rest.findLastIndex((message) => message.role === "assistant");
    if (answered === -1) return acpPromptFromMessages(rest, images);
    return acpCatchUpPrompt(rest.slice(0, answered + 1), rest.slice(answered + 1), images);
}

function images(connection: AcpConnection): boolean {
    return connection.init.agentCapabilities?.promptCapabilities?.image === true;
}

function errorText(error: unknown): string {
    if (typeof error !== "object" || error === null || !("message" in error)) return String(error);
    const message = String((error as { message: unknown }).message);
    // An ACP agent's own failure arrives as a JSON-RPC internal error carrying its text.
    const details = (error as { data?: { details?: unknown } }).data?.details;
    return typeof details === "string" && details.length > 0 ? `${message}: ${details}` : message;
}

/**
 * The agent's service refused the request as too many, which passes in seconds. A quota or
 * usage limit is often sent with the same status but resets in hours, so it is never retried.
 */
function isRateLimited(error: unknown): boolean {
    const text = errorText(error);
    return (
        /\b429\b|too many requests|rate[ _-]?limit(?:ed)?\b/iu.test(text) &&
        !/quota|usage[ _-]?limit|weekly|monthly|daily|session limit|billing|credits?\b|plan limit|resets? (?:at|in|on)\b|try again (?:at|in \d+ ?(?:h|hours?|d|days?)\b)/iu.test(
            text,
        )
    );
}

function errorDone(error: unknown, stderr: string): SessionEvent {
    const message = errorText(error);
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    return {
        type: "done",
        state: "error",
        kind: "internal_error",
        message: tail.length === 0 ? message : `${message}\n${tail}`,
    };
}

function abortPromise(signal: AbortSignal | undefined): Promise<typeof ABORTED> {
    return new Promise((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
            resolve(ABORTED);
            return;
        }
        signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
    });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
    await Promise.race([
        promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, ms).unref()),
    ]);
}

/** The agent's option for an answer, or a cancelled outcome when it offers none that fits. */
function pick(
    params: acp.RequestPermissionRequest,
    answer: AcpPermissionAnswer,
): acp.RequestPermissionResponse {
    if (answer === "cancelled") return { outcome: { outcome: "cancelled" } };
    const kinds: readonly acp.PermissionOptionKind[] =
        answer === "allow_for_session"
            ? ["allow_always", "allow_once"]
            : answer === "allow_once"
              ? ["allow_once"]
              : ["reject_once", "reject_always"];
    for (const kind of kinds) {
        const option = params.options.find((candidate) => candidate.kind === kind);
        if (option !== undefined) {
            return { outcome: { outcome: "selected", optionId: option.optionId } };
        }
    }
    return { outcome: { outcome: "cancelled" } };
}

/** The action an ask is about, as the agent described it; a long input is cut short. */
function permissionAction(toolCall: acp.ToolCallUpdate): string {
    const title = toolCall.title?.trim();
    const raw =
        toolCall.rawInput === undefined || toolCall.rawInput === null
            ? undefined
            : JSON.stringify(toolCall.rawInput);
    const input =
        raw !== undefined && raw.length > MAX_ACTION_INPUT
            ? `${raw.slice(0, MAX_ACTION_INPUT)}… (${raw.length - MAX_ACTION_INPUT} more characters not shown)`
            : raw;
    const text = [title, input].filter((part) => part !== undefined && part.length > 0).join("\n");
    return text.length === 0 ? "An action the agent did not describe." : text;
}
