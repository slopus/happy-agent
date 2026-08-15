import { createId } from "@paralleldrive/cuid2";
import type { HappyTracingEvent } from "happy-plugins";
import type { Context as RuntimeContext } from "@steve.kite/stdlib";

import {
    compactConversation,
    type CompactConversationResult,
} from "./compaction/compactConversation.js";
import { resolvePreInferenceContextTokens } from "./compaction/resolvePreInferenceContextTokens.js";
import { runCompactionWithEvents } from "./compaction/runCompactionWithEvents.js";
import type { AgentContext } from "./context/AgentContext.js";
import { runAgentLoop, type AgentLoopEvent, type AgentLoopResult } from "./loop.js";
import { toProviderMessages } from "./loop.js";
import { toExecutorTool } from "./impl/toExecutorTool.js";
import { createProviderPrompt } from "./prompt/createSystemPrompt.js";
import { prepareProviderMessageImages } from "./impl/prepareProviderMessageImages.js";
import { reconcileAgentsMdMessages } from "./impl/reconcileAgentsMdMessages.js";
import { createDebugProvider, type DebugLog } from "../debug/index.js";
import {
    printAgentMessageToConsole,
    type AgentConsole,
} from "./impl/printAgentMessageToConsole.js";
import type {
    AnyDefinedTool,
    ContentBlock,
    Message,
    SteeringMessage,
    SystemMessage,
    UserMessage,
} from "./types.js";
import type { Context, Model, Provider, ServiceTier } from "@slopus/rig-execution";
import { toLocalDate } from "../executor/toLocalDate.js";
import type { PermissionMode, PermissionReviewAgent } from "../permissions/index.js";
import { isPermissionReduction } from "../permissions/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { resolveModelImageProfile } from "./impl/resolveModelImageProfile.js";

export type AgentStatus = "idle" | "running" | "aborted";

export interface QueuedAgentMessage {
    id: string;
    message: Message;
}

export type AgentToolSelector = (options: {
    model: Model;
    provider: Provider;
}) => readonly AnyDefinedTool[];

export interface AgentSnapshot {
    appendSystemPrompt?: string;
    id: string;
    providerId: string;
    modelId: string;
    effort?: string;
    serviceTier?: ServiceTier;
    status: AgentStatus;
    instructions?: string;
    messages: readonly Message[];
    /** Compacted model-facing history. Omitted while it matches the visible transcript. */
    contextMessages?: readonly Message[];
    queue: readonly QueuedAgentMessage[];
    tools: readonly string[];
    lastRunId?: string;
    systemPrompt?: string;
}

export interface AgentOptions {
    /** Allows this dedicated side agent to use the provider's hidden permission-review model. */
    allowReviewerModel?: boolean;
    appendSystemPrompt?: string;
    provider: Provider;
    /** Creates the sister agent that reviews Auto permission decisions, on first use. */
    createPermissionReviewAgent?: () => PermissionReviewAgent;
    /**
     * Delivers the project's AGENTS.md instructions to the model. The permission reviewer turns
     * this off, because repository content must never instruct the agent judging an action.
     */
    projectInstructions?: "include" | "exclude";
    /**
     * Reads the user's global AGENTS.md. It is consulted before every turn, so instructions the
     * user changes mid-session reach the model without restarting anything.
     */
    readGlobalInstructions?: () => Promise<string | undefined>;
    modelId: string;
    context: AgentContext;
    id?: string;
    effort?: string;
    serviceTier?: ServiceTier;
    startDate?: string;
    messages?: readonly Message[];
    contextMessages?: readonly Message[];
    instructions?: string;
    systemPrompt?: string;
    /** Stable owning session identity used by plugin lifecycle tracing. */
    traceSessionId?: string;
    /** Omit for a tool-free agent; product runtimes compose provider tools explicitly. */
    tools?: readonly AnyDefinedTool[];
    /** Selects default tools without coupling the generic agent to provider tool registries. */
    toolSelector?: AgentToolSelector;
    idFactory?: () => string;
    now?: () => number;
    console?: AgentConsole;
    printToConsole?: boolean;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
}

export interface AgentRunOptions {
    /** Refreshes an explicitly supplied tool array before each inference iteration. */
    beforeInference?: () => Promise<void>;
    clientSubmissionId?: string;
    debug?: DebugLog;
    displayText?: string;
    signal?: AbortSignal;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
}

export type AgentRunResult = AgentLoopResult & {
    debugDirectory?: string;
    runId: string;
};

export interface AgentCompactionResult {
    compacted: boolean;
    compactedMessageCount: number;
    estimatedTokensAfter: number;
    estimatedTokensBefore: number;
    retainedMessageCount: number;
}

export class Agent {
    readonly id: string;
    readonly provider: Provider;
    readonly context: AgentContext;

    readonly #createPermissionReviewAgent: (() => PermissionReviewAgent) | undefined;
    readonly #allowReviewerModel: boolean;
    readonly #projectInstructions: "include" | "exclude";
    readonly #readGlobalInstructions: (() => Promise<string | undefined>) | undefined;
    #permissionReviewAgent: PermissionReviewAgent | undefined;
    #appendSystemPrompt: string | undefined;
    #model: Model;
    #effort: string | undefined;
    #serviceTier: ServiceTier | undefined;
    readonly #startDate: string;
    #instructions: string | undefined;
    #systemPrompt: string | undefined;
    #tools: readonly AnyDefinedTool[];
    #toolSelector: AgentToolSelector | undefined;
    #usesExplicitTools: boolean;
    #idFactory: () => string;
    #now: () => number;
    #console: AgentConsole;
    #printToConsole: boolean;
    #onEvent: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
    #onMessage: ((message: Message) => void | Promise<void>) | undefined;
    #messages: Message[] = [];
    #contextMessages: Message[] | undefined;
    #queue: QueuedAgentMessage[] = [];
    #steeringQueue: SteeringMessage[] = [];
    #steeringController = new AbortController();
    #status: AgentStatus = "idle";
    #lastRunId: string | undefined;
    #activeRunId: string | undefined;
    readonly #traceSessionId: string;
    #resetVersion = 0;

    constructor(options: AgentOptions) {
        this.#appendSystemPrompt = options.appendSystemPrompt;
        this.#idFactory = options.idFactory ?? createId;
        this.id = options.id ?? this.#idFactory();
        this.provider = options.provider;
        this.#createPermissionReviewAgent = options.createPermissionReviewAgent;
        this.#allowReviewerModel = options.allowReviewerModel === true;
        this.#projectInstructions = options.projectInstructions ?? "include";
        this.#readGlobalInstructions = options.readGlobalInstructions;
        this.#model = this.#findModel(options.modelId, this.#allowReviewerModel);
        this.context = options.context;
        this.#effort = options.effort ?? this.#model.defaultThinkingLevel;
        this.#serviceTier = this.#validateServiceTier(options.serviceTier);
        this.#instructions = options.instructions;
        this.#systemPrompt = options.systemPrompt;
        this.#toolSelector = options.toolSelector;
        this.#usesExplicitTools = options.tools !== undefined;
        this.#tools =
            options.tools ??
            options.toolSelector?.({ model: this.#model, provider: options.provider }) ??
            [];
        this.#now = options.now ?? Date.now;
        this.#startDate = options.startDate ?? toLocalDate(this.#now());
        this.#console = options.console ?? console;
        this.#printToConsole = options.printToConsole ?? true;
        this.#onEvent = options.onEvent;
        this.#onMessage = options.onMessage;
        this.#traceSessionId = options.traceSessionId ?? this.id;
        this.#messages = [...(options.messages ?? [])];
        this.#contextMessages =
            options.contextMessages === undefined ? undefined : [...options.contextMessages];
    }

    get status(): AgentStatus {
        return this.#status;
    }

    get model(): Model {
        return this.#model;
    }

    get messages(): readonly Message[] {
        return this.#messages;
    }

    get queue(): readonly QueuedAgentMessage[] {
        return this.#queue;
    }

    get tools(): readonly AnyDefinedTool[] {
        return this.#tools;
    }

    get permissionMode(): PermissionMode {
        return this.context.permissions?.mode ?? "full_access";
    }

    get canChangeModel(): boolean {
        return (
            this.#messages.length === 0 &&
            this.#queue.length === 0 &&
            this.#activeRunId === undefined
        );
    }

    get confirmedServiceTier(): ServiceTier | undefined {
        return this.#serviceTier;
    }

    setInstructions(instructions: string | undefined): void {
        this.#instructions = instructions;
    }

    setAppendSystemPrompt(appendSystemPrompt: string | undefined): void {
        this.#appendSystemPrompt = appendSystemPrompt;
    }

    setSystemPrompt(systemPrompt: string | undefined): void {
        this.#systemPrompt = systemPrompt;
    }

    setEffort(effort: string | undefined): void {
        this.#effort = effort;
    }

    setServiceTier(serviceTier: ServiceTier | undefined): void {
        this.#serviceTier = this.#validateServiceTier(serviceTier);
    }

    setModel(modelId: string, effort: string | undefined): void {
        const model = this.#findModel(modelId);
        this.#model = model;
        this.#effort = effort ?? model.defaultThinkingLevel;
        if (!this.#usesExplicitTools && this.#toolSelector !== undefined) {
            this.#tools = this.#toolSelector({ model, provider: this.provider });
        }
    }

    #takeSteering(): readonly SteeringMessage[] {
        const steering = this.#steeringQueue;
        this.#steeringQueue = [];
        if (this.#steeringController.signal.aborted) {
            this.#steeringController = new AbortController();
        }
        for (const message of steering) this.#printMessage(message);
        return steering;
    }

    setTools(tools: readonly AnyDefinedTool[]): void {
        this.#tools = tools;
    }

    async setPermissionMode(mode: PermissionMode): Promise<void> {
        const permissions = this.context.permissions;
        if (permissions === undefined) {
            throw new Error("Permission settings are unavailable for this agent.");
        }
        if (isPermissionReduction(permissions.mode, mode)) {
            await this.context.bash.killAllSessions?.();
        }
        permissions.setMode(mode);
    }

    async reset(): Promise<void> {
        await Promise.all([this.provider.reset?.(), this.#permissionReviewAgent?.reset()]);
        this.#messages = [];
        this.#contextMessages = undefined;
        this.#queue = [];
        this.#steeringQueue = [];
        if (this.#activeRunId === undefined) this.#steeringController = new AbortController();
        this.#lastRunId = undefined;
        this.#resetVersion += 1;
        if (this.#activeRunId === undefined) {
            this.#status = "idle";
        }
    }

    async close(): Promise<void> {
        const reviewer = this.#permissionReviewAgent;
        this.#permissionReviewAgent = undefined;
        await Promise.all([this.provider.close?.(), reviewer?.close()]);
    }

    addSteering(text: string): SystemMessage {
        return this.enqueueSystemMessage(text);
    }

    enqueueSystemMessage(text: string): SystemMessage {
        const message: SystemMessage = {
            role: "system",
            id: this.#idFactory(),
            blocks: [{ type: "text", text }],
        };
        this.enqueueMessage(message);
        return message;
    }

    enqueueUserMessage(text: string | readonly ContentBlock[]): UserMessage {
        const message: UserMessage = {
            role: "user",
            id: this.#idFactory(),
            blocks: typeof text === "string" ? [{ type: "text", text }] : text,
        };
        this.enqueueMessage(message);
        return message;
    }

    enqueueMessage(message: Message): QueuedAgentMessage {
        const queued = {
            id: this.#idFactory(),
            message,
        };
        this.#queue.push(queued);
        return queued;
    }

    /**
     * Adds a durable message after a run failed outside the normal loop result.
     *
     * This is only valid once the run has unwound; mutating the transcript held
     * by an active loop would create two competing context owners.
     */
    recordMessage(message: Message): void {
        if (this.#activeRunId !== undefined) {
            throw new Error("Cannot record a message while the agent is running.");
        }
        this.#messages.push(message);
        this.#contextMessages?.push(message);
    }

    /**
     * Replaces only the model-facing conversation while preserving durable visible history.
     *
     * The next provider run receives the complete replacement and naturally rebuilds any cached
     * prefix that no longer matches. An active loop owns its context, so replacing it mid-run
     * would create two competing histories and is rejected.
     */
    replaceContextMessages(messages: readonly Message[]): void {
        if (this.#activeRunId !== undefined) {
            throw new Error("Cannot replace model context while the agent is running.");
        }
        this.#contextMessages = [...messages];
    }

    async send(
        ctx: RuntimeContext,
        text: string | readonly ContentBlock[],
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        if (this.#activeRunId !== undefined) {
            throw new Error(`Agent '${this.id}' is already running`);
        }

        this.enqueueMessage({
            role: "user",
            id: options.clientSubmissionId ?? this.#idFactory(),
            blocks: typeof text === "string" ? [{ type: "text", text }] : text,
        });
        return this.run(ctx, options);
    }

    async steer(content: string | readonly ContentBlock[]): Promise<void> {
        this.steerMessage({
            role: "user",
            id: this.#idFactory(),
            blocks: typeof content === "string" ? [{ type: "text", text: content }] : content,
        });
    }

    steerMessage(message: SteeringMessage): void {
        if (this.#activeRunId === undefined) {
            throw new Error(`Agent '${this.id}' is not running`);
        }
        this.#steeringQueue.push(message);
        this.#steeringController.abort();
    }

    async compact(
        ctx: RuntimeContext,
        signal?: AbortSignal,
        onEvent?: AgentRunOptions["onEvent"],
        onMessage?: AgentRunOptions["onMessage"],
    ): Promise<AgentCompactionResult> {
        if (this.#activeRunId !== undefined) {
            throw new Error("Wait for the active response to finish before compacting.");
        }

        const runId = this.#idFactory();
        this.#activeRunId = runId;
        this.#status = "running";
        try {
            const result = await this.#compactContext(ctx, {
                eventOptions: {
                    ...(onEvent === undefined ? {} : { onEvent }),
                    ...(onMessage === undefined ? {} : { onMessage }),
                },
                force: true,
                reason: "manual",
                ...(signal !== undefined ? { signal } : {}),
            });
            this.#status = "idle";
            return result;
        } finally {
            this.#steeringQueue = [];
            this.#steeringController = new AbortController();
            if (this.#activeRunId === runId) this.#activeRunId = undefined;
            if (this.#status === "running") this.#status = signal?.aborted ? "aborted" : "idle";
        }
    }

    async run(ctx: RuntimeContext, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        if (this.#activeRunId !== undefined) {
            throw new Error(`Agent '${this.id}' is already running`);
        }

        const runId = this.#idFactory();
        const turnStartedAt = this.#now();
        const resetVersion = this.#resetVersion;
        this.#lastRunId = runId;
        this.#activeRunId = runId;
        this.#status = "running";
        this.#steeringController = new AbortController();
        this.#drainQueueToTranscript();
        this.#emitTrace({
            model: this.#model.id,
            provider: this.provider.id,
            sessionId: this.#traceSessionId,
            timestamp: turnStartedAt,
            type: "turn_started",
        });
        const provider =
            options.debug === undefined
                ? this.provider
                : createDebugProvider(this.provider, {
                      log: options.debug,
                      runId,
                      source: "agent",
                  });
        const inferenceStartedAt = new Map<number, number>();
        const finishPendingInferences = (timestamp: number) => {
            for (const [iteration, startedAt] of inferenceStartedAt) {
                this.#emitTrace({
                    durationMs: Math.max(0, timestamp - startedAt),
                    iteration,
                    model: this.#model.id,
                    provider: this.provider.id,
                    sessionId: this.#traceSessionId,
                    success: false,
                    timestamp,
                    type: "inference_request_finished",
                });
            }
            inferenceStartedAt.clear();
        };

        try {
            await this.#compactContext(ctx, {
                eventOptions: options,
                force: false,
                provider,
                reason: "threshold",
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
            });

            const beforeAgentsMd = this.#contextMessages ?? this.#messages;
            // Read before every turn, so an edit made while this session is open takes effect on
            // the next thing the user asks for.
            const globalInstructions =
                this.#projectInstructions === "exclude" ||
                this.#readGlobalInstructions === undefined
                    ? undefined
                    : await this.#readGlobalInstructions();
            const withAgentsMd =
                this.#projectInstructions === "exclude"
                    ? beforeAgentsMd
                    : await reconcileAgentsMdMessages({
                          fs: this.context.fs,
                          ...(globalInstructions === undefined ? {} : { globalInstructions }),
                          idFactory: this.#idFactory,
                          messages: beforeAgentsMd,
                      });
            // Recording the project instructions makes the model's history diverge from the
            // visible transcript, which is what keeps superseded instructions readable later.
            if (withAgentsMd !== beforeAgentsMd) {
                this.#contextMessages = [...withAgentsMd];
            }

            const contextWasExplicit = this.#contextMessages !== undefined;
            let contextCompactedDuringRun = false;
            let inferenceIteration: number | undefined;
            const toolStartedAt = new Map<string, { name: string; timestamp: number }>();
            const traceLoopEvent = (event: AgentLoopEvent) => {
                const timestamp = this.#now();
                if (event.type === "inference_iteration_start") {
                    inferenceIteration = event.iteration;
                    inferenceStartedAt.set(event.iteration, timestamp);
                    this.#emitTrace({
                        iteration: event.iteration,
                        model: this.#model.id,
                        provider: this.provider.id,
                        sessionId: this.#traceSessionId,
                        timestamp,
                        type: "inference_request_started",
                    });
                    return;
                }
                if (
                    (event.type === "done" || event.type === "error") &&
                    inferenceIteration !== undefined
                ) {
                    const startedAt = inferenceStartedAt.get(inferenceIteration) ?? timestamp;
                    const message = event.type === "done" ? event.message : event.error;
                    this.#emitTrace({
                        durationMs: Math.max(0, timestamp - startedAt),
                        iteration: inferenceIteration,
                        model: this.#model.id,
                        provider: this.provider.id,
                        sessionId: this.#traceSessionId,
                        success: event.type === "done",
                        timestamp,
                        type: "inference_request_finished",
                        ...(message.usage === undefined
                            ? {}
                            : {
                                  usage: {
                                      cacheRead: message.usage.cacheRead,
                                      cacheWrite: message.usage.cacheWrite,
                                      input: message.usage.input,
                                      output: message.usage.output,
                                      ...(message.usage.reasoning === undefined
                                          ? {}
                                          : { reasoning: message.usage.reasoning }),
                                      totalTokens: message.usage.totalTokens,
                                  },
                              }),
                    });
                    inferenceStartedAt.delete(inferenceIteration);
                    return;
                }
                if (event.type === "tool_execution_start") {
                    toolStartedAt.set(event.toolCall.id, {
                        name: event.toolCall.name,
                        timestamp,
                    });
                    this.#emitTrace({
                        name: event.toolCall.name,
                        sessionId: this.#traceSessionId,
                        timestamp,
                        toolCallId: event.toolCall.id,
                        type: "tool_call_started",
                    });
                    return;
                }
                if (event.type === "tool_execution_end") {
                    const started = toolStartedAt.get(event.result.toolCallId);
                    // Synthetic results for calls that never executed remain durable agent-loop
                    // events, but are not tracing lifecycle completions because no start occurred.
                    if (started === undefined) return;
                    this.#emitTrace({
                        durationMs: Math.max(0, timestamp - started.timestamp),
                        name: started.name,
                        sessionId: this.#traceSessionId,
                        success: event.result.isError !== true,
                        timestamp,
                        toolCallId: event.result.toolCallId,
                        type: "tool_call_finished",
                    });
                    toolStartedAt.delete(event.result.toolCallId);
                }
            };
            const loopOptions: Parameters<typeof runAgentLoop>[1] = {
                ...(this.#allowReviewerModel ? { allowReviewerModel: true } : {}),
                provider,
                ...(this.#createPermissionReviewAgent === undefined
                    ? {}
                    : {
                          // Auto may be selected long after the agent is built, so the sister
                          // agent stays unbuilt until a review actually needs it.
                          permissionReviewAgent: () =>
                              (this.#permissionReviewAgent ??=
                                  this.#createPermissionReviewAgent!()),
                      }),
                modelId: this.#model.id,
                tools: this.#tools,
                ...(options.beforeInference === undefined
                    ? {}
                    : {
                          resolveTools: async () => {
                              await options.beforeInference?.();
                              return this.#tools;
                          },
                      }),
                messages: this.#messages,
                sessionId: runId,
                startDate: this.#startDate,
                idFactory: this.#idFactory,
                now: this.#now,
                context: this.context,
                onEvent: async (event) => {
                    traceLoopEvent(event);
                    await this.#handleEvent(event, options);
                },
                onMessage: async (message) => this.#handleMessage(message, options),
                onContextChanged: (messages) => {
                    if (this.#resetVersion === resetVersion) {
                        this.#contextMessages = [...messages];
                    }
                },
                takeSteering: () => this.#takeSteering(),
                getSteeringSignal: () => this.#steeringController.signal,
                compactContext: async (messages, compaction) => {
                    const result = await this.#compactMessages(ctx, {
                        eventOptions: options,
                        messages,
                        createProviderContext: compaction.createProviderContext,
                        force: compaction.force,
                        provider,
                        reason: compaction.force ? "context_window" : "threshold",
                        ...(compaction.reportedTokens === undefined
                            ? {}
                            : { reportedTokens: compaction.reportedTokens }),
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                    });
                    if (this.#resetVersion !== resetVersion) return undefined;
                    contextCompactedDuringRun ||= result.compacted;
                    return result;
                },
            };
            if (this.#contextMessages !== undefined) {
                loopOptions.contextMessages = this.#contextMessages;
            }
            if (this.#appendSystemPrompt !== undefined) {
                loopOptions.appendSystemPrompt = this.#appendSystemPrompt;
            }
            if (this.#systemPrompt !== undefined) loopOptions.systemPrompt = this.#systemPrompt;
            if (this.#effort !== undefined) loopOptions.effort = this.#effort;
            if (this.#serviceTier !== undefined) loopOptions.serviceTier = this.#serviceTier;
            if (this.#instructions !== undefined) loopOptions.instructions = this.#instructions;
            if (options.signal !== undefined) loopOptions.signal = options.signal;
            if (options.debug !== undefined) loopOptions.debug = options.debug;

            const result = await runAgentLoop(ctx, loopOptions);
            const finishedAt = this.#now();
            finishPendingInferences(finishedAt);
            this.#emitTrace({
                durationMs: Math.max(0, finishedAt - turnStartedAt),
                model: this.#model.id,
                provider: this.provider.id,
                sessionId: this.#traceSessionId,
                stopReason: result.stopReason,
                success: result.stopReason !== "error",
                timestamp: finishedAt,
                type: "turn_finished",
            });

            if (this.#activeRunId === runId) {
                this.#activeRunId = undefined;
            }
            this.#steeringQueue = [];
            this.#steeringController = new AbortController();
            if (this.#resetVersion === resetVersion) {
                this.#messages = [...result.messages];
                if (
                    contextWasExplicit ||
                    contextCompactedDuringRun ||
                    !hasSameMessageIdentity(result.messages, result.contextMessages)
                ) {
                    this.#contextMessages = [...result.contextMessages];
                } else {
                    this.#contextMessages = undefined;
                }
                this.#status = result.stopReason === "aborted" ? "aborted" : "idle";
            } else if (this.#status === "running") {
                this.#status = "idle";
            }
            return {
                ...result,
                ...(options.debug === undefined ? {} : { debugDirectory: options.debug.directory }),
                runId,
            };
        } catch (error) {
            const finishedAt = this.#now();
            finishPendingInferences(finishedAt);
            this.#emitTrace({
                durationMs: Math.max(0, finishedAt - turnStartedAt),
                model: this.#model.id,
                provider: this.provider.id,
                sessionId: this.#traceSessionId,
                stopReason: options.signal?.aborted ? "aborted" : "error",
                success: false,
                timestamp: finishedAt,
                type: "turn_finished",
            });
            if (this.#activeRunId === runId) {
                this.#activeRunId = undefined;
            }
            this.#steeringQueue = [];
            this.#steeringController = new AbortController();
            if (this.#resetVersion === resetVersion) {
                this.#status = options.signal?.aborted ? "aborted" : "idle";
            } else if (this.#status === "running") {
                this.#status = "idle";
            }
            throw error;
        }
    }

    snapshot(): AgentSnapshot {
        return {
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            id: this.id,
            providerId: this.provider.id,
            modelId: this.#model.id,
            status: this.#status,
            messages: [...this.#messages],
            queue: [...this.#queue],
            tools: this.#tools.map((tool) => tool.name),
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            ...(this.#contextMessages !== undefined
                ? { contextMessages: [...this.#contextMessages] }
                : {}),
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            ...(this.#lastRunId !== undefined ? { lastRunId: this.#lastRunId } : {}),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
        };
    }

    #findModel(modelId: string, allowReviewerModel = false): Model {
        const model =
            this.provider.models.find((candidate) => candidate.id === modelId) ??
            (allowReviewerModel && this.provider.reviewerModel?.id === modelId
                ? this.provider.reviewerModel
                : undefined);
        if (!model) {
            throw new Error(`Unknown model '${modelId}' for provider '${this.provider.id}'`);
        }
        return model;
    }

    #validateServiceTier(serviceTier: ServiceTier | undefined): ServiceTier | undefined {
        if (serviceTier === undefined) return undefined;
        if (this.provider.serviceTiers?.includes(serviceTier) === true) return serviceTier;
        throw new Error(`Provider '${this.provider.id}' does not support fast inference.`);
    }

    #drainQueueToTranscript(): void {
        if (this.#queue.length === 0) {
            return;
        }

        const queued = this.#queue;
        this.#queue = [];
        for (const entry of queued) {
            this.#messages.push(entry.message);
            this.#contextMessages?.push(entry.message);
            this.#printMessage(entry.message);
        }
    }

    async #compactContext(
        ctx: RuntimeContext,
        options: {
            eventOptions: AgentRunOptions;
            force: boolean;
            provider?: Provider;
            reason: "context_window" | "manual" | "threshold";
            signal?: AbortSignal;
        },
    ): Promise<AgentCompactionResult> {
        const resetVersion = this.#resetVersion;
        const messages = this.#contextMessages ?? this.#messages;
        const reportedTokens = resolvePreInferenceContextTokens(messages);
        const result = await this.#compactMessages(ctx, {
            messages,
            eventOptions: options.eventOptions,
            force: options.force,
            reason: options.reason,
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            ...(reportedTokens === undefined ? {} : { reportedTokens }),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        if (result.compacted && this.#resetVersion === resetVersion) {
            if (result.compactionMessage === undefined) {
                throw new Error("Compaction completed without a durable compaction message.");
            }
            this.#contextMessages = [...result.contextMessages];
            this.#messages.push(result.compactionMessage);
            await this.#handleMessage(result.compactionMessage, options.eventOptions);
        }
        return {
            compacted: result.compacted,
            compactedMessageCount: result.compactedMessageCount,
            estimatedTokensAfter: result.estimatedTokensAfter,
            estimatedTokensBefore: result.estimatedTokensBefore,
            retainedMessageCount: result.retainedMessageCount,
        };
    }

    async #compactMessages(
        ctx: RuntimeContext,
        options: {
            messages: readonly Message[];
            createProviderContext?: (messages: readonly Message[]) => Promise<Context>;
            eventOptions: AgentRunOptions;
            force: boolean;
            provider?: Provider;
            reason: "context_window" | "manual" | "threshold";
            reportedTokens?: number;
            signal?: AbortSignal;
        },
    ): Promise<CompactConversationResult> {
        return runCompactionWithEvents({
            compact: (onCompactionStart) =>
                compactConversation(ctx, {
                    provider: options.provider ?? this.provider,
                    model: this.#model,
                    messages: options.messages,
                    createProviderContext:
                        options.createProviderContext ??
                        (async (messages) => {
                            const providerPrompt = await createProviderPrompt(ctx, {
                                ...(this.#appendSystemPrompt !== undefined
                                    ? { appendSystemPrompt: this.#appendSystemPrompt }
                                    : {}),
                                ...(this.#systemPrompt !== undefined
                                    ? { systemPrompt: this.#systemPrompt }
                                    : {}),
                                provider: options.provider ?? this.provider,
                                model: this.#model,
                                ...(this.#instructions !== undefined
                                    ? { instructions: this.#instructions }
                                    : {}),
                                messages,
                                context: this.context,
                                ...(this.#effort === undefined ? {} : { effort: this.#effort }),
                                tools: this.#tools,
                            });
                            const providerMessages = toProviderMessages(messages, {
                                model: this.#model,
                                now: this.#now,
                                providerId: (options.provider ?? this.provider).id,
                            });
                            const preparedMessages = await prepareProviderMessageImages(
                                providerMessages,
                                resolveModelImageProfile(this.#model),
                            );
                            const providerTools = this.#tools.map(toExecutorTool);
                            return {
                                ...providerPrompt,
                                messages: preparedMessages,
                                ...(providerTools.length === 0 ? {} : { tools: providerTools }),
                            };
                        }),
                    idFactory: this.#idFactory,
                    now: this.#now,
                    force: options.force,
                    startDate: this.#startDate,
                    onCompactionStart,
                    ...(options.reportedTokens === undefined
                        ? {}
                        : { reportedTokens: options.reportedTokens }),
                    ...(this.#effort !== undefined ? { thinking: this.#effort } : {}),
                    ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
                    ...(options.signal !== undefined ? { signal: options.signal } : {}),
                }),
            idFactory: this.#idFactory,
            now: this.#now,
            onEvent: async (event) => {
                try {
                    await this.#handleEvent(event, options.eventOptions);
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    this.#console.error?.(
                        `[agent:${this.id}] compaction lifecycle observer failed`,
                        error,
                    );
                }
            },
            reason: options.reason,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    #printMessage(message: Message): void {
        if (!this.#printToConsole) {
            return;
        }

        printAgentMessageToConsole(message, this.#console);
    }

    #printEvent(event: AgentLoopEvent): void {
        if (!this.#printToConsole) {
            return;
        }

        if (event.type === "toolcall_end") {
            this.#console.log(
                `[agent:${this.id}] tool_call ${event.toolCall.name}:${event.toolCall.id}`,
            );
        }
    }

    async #handleMessage(message: Message, options: AgentRunOptions): Promise<void> {
        this.#printMessage(message);
        await this.#onMessage?.(message);
        await options.onMessage?.(message);
    }

    async #handleEvent(event: AgentLoopEvent, options: AgentRunOptions): Promise<void> {
        this.#printEvent(event);
        await this.#onEvent?.(event);
        await options.onEvent?.(event);
    }

    #emitTrace(event: HappyTracingEvent): void {
        try {
            this.context.plugins?.trace?.(event);
        } catch {
            // Tracing is observation only and never changes the agent run.
        }
    }
}

function hasSameMessageIdentity(
    messages: readonly Message[],
    contextMessages: readonly Message[],
): boolean {
    return (
        messages.length === contextMessages.length &&
        messages.every((message, index) => message === contextMessages[index])
    );
}
