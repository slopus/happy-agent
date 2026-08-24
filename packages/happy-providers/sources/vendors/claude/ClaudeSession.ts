import { randomUUID } from "node:crypto";

import {
    query as defaultClaudeSdkQuery,
    type SDKAssistantMessageError,
    type SDKRateLimitInfo,
    type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { BaseSession } from "@/core/BaseSession.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { EmptyResponseError, emptyResponseDoneEvent } from "@/core/EmptyResponseError.js";
import type { ProviderUsage } from "@/core/ProviderUsage.js";
import { EMPTY_SESSION_USAGE, type SessionUsage } from "@/core/SessionUsage.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext, SessionToolCallBlock } from "@/core/SessionContext.js";
import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";
import type { ClaudeCredential } from "@/vendors/VendorCredential.js";
import { claudeUsageFromRateLimitInfo } from "@/vendors/claude/claudeUsageFromRateLimitInfo.js";
import { ClaudePromptQueue } from "@/vendors/claude/impl/ClaudePromptQueue.js";
import {
    classifyClaudeError,
    claudeResultErrorMessage,
    isClaudeMidResponseServerError,
} from "@/vendors/claude/errors/claudeErrors.js";
import { ClaudeToolBridge } from "@/vendors/claude/impl/ClaudeToolBridge.js";
import {
    createClaudeLivePromptMessage,
    createClaudeSessionReplay,
    type ClaudeSessionReplay,
} from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import { claudeMessageIdentity } from "@/vendors/claude/impl/claudeMessageIdentity.js";
import { resolveClaudeLiveDelta } from "@/vendors/claude/impl/resolveClaudeLiveDelta.js";
import {
    claudeSdkBuiltInToolNames,
    toClaudeSdkOptions,
} from "@/vendors/claude/impl/toClaudeSdkOptions.js";
import { toClaudeRetryEvent } from "@/vendors/claude/impl/toClaudeRetryEvent.js";
import type { Context } from "@steve.kite/stdlib";

export type ClaudeSdkQuery = typeof defaultClaudeSdkQuery;

const CLAUDE_QUERY_ABORTED = Symbol("claude_query_aborted");

/**
 * The SDK answers a json_schema output format by making the model call this tool of its own, then
 * hands the validated value back on the result message. It belongs to the SDK, not to the caller,
 * so the turn is a normal completion that ends in text rather than a tool call to run.
 */
const CLAUDE_STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
export interface ClaudeSessionOptions extends InferenceRetryOptions {
    instructions: string;
    credential: ClaudeCredential;
    env?: NodeJS.ProcessEnv;
    model?: string;
    modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
    /** Receives the account usage the limiter reports during inference. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    pathToClaudeCodeExecutable?: string;
    query?: ClaudeSdkQuery;
    tools?: readonly SessionTool[];
    userAgent?: string;
}

export class ClaudeSession extends BaseSession {
    readonly credential: ClaudeCredential;
    readonly env: NodeJS.ProcessEnv;
    readonly model: string | undefined;
    readonly pathToClaudeCodeExecutable: string | undefined;
    readonly userAgent: string | undefined;
    readonly tools: readonly SessionTool[] | undefined;

    private activeEffort: SessionReasoningEffort | undefined;
    private activeModel: string | undefined;
    private readonly modelConfigurations:
        | Readonly<Record<string, SessionModelConfiguration>>
        | undefined;
    private context: SessionContext;
    private sdkSessionId = randomUUID();
    private readonly query: ClaudeSdkQuery;
    private activeQuery: ReturnType<ClaudeSdkQuery> | undefined;
    private activeQueryKey: string | undefined;
    /** Wire identity of the conversation the live query holds, including what it generated. */
    private sentConversation: readonly string[] | undefined;
    private activePromptQueue: ClaudePromptQueue | undefined;
    private activeReplay: ClaudeSessionReplay | undefined;
    private activeToolBridge: ClaudeToolBridge | undefined;
    private lastQueryToolCalls: Omit<SessionToolCallBlock, "type">[] = [];
    private readonly onAccountUsage: ((usage: ProviderUsage) => void) | undefined;
    private readonly resolveInferenceMaxRetries: () => number;
    private readonly retryWait: NonNullable<InferenceRetryOptions["waitForInferenceRetry"]>;

    constructor(id: string, options: ClaudeSessionOptions) {
        super(id);
        this.credential = options.credential;
        this.env = options.env ?? process.env;
        this.model = options.model;
        this.activeModel = options.model;
        this.resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.retryWait = options.waitForInferenceRetry ?? waitForInferenceRetry;
        this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
        this.userAgent = options.userAgent;
        this.tools = options.tools;
        this.modelConfigurations = options.modelConfigurations;
        this.onAccountUsage = options.onAccountUsage;
        this.query = options.query ?? defaultClaudeSdkQuery;
        this.context = { instructions: options.instructions, messages: [] };
    }

    /**
     * Hands on what the limiter said about the account. Reporting usage is
     * bookkeeping beside the run, so a listener that throws cannot break it.
     */
    private reportAccountUsage(info: SDKRateLimitInfo): void {
        if (this.onAccountUsage === undefined) return;
        const usage = claudeUsageFromRateLimitInfo(info, {
            capturedAt: Date.now(),
            providerId: "claude",
        });
        if (usage === null) return;
        try {
            this.onAccountUsage(usage);
        } catch {
            // A usage listener never decides whether inference continues.
        }
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        if (ctx.lifetime?.aborted) return emptyStream();
        return this.streamRun(ctx, request);
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const original: SessionContext = {
            instructions: options.context.instructions,
            messages: [...options.context.messages],
        };
        const { instructions } = options;
        const signal = ctx.lifetime;
        if (signal?.aborted) return { status: "cancelled", context: original };
        const requestedModel = options.model ?? this.activeModel ?? this.model;
        const model =
            requestedModel === undefined ? undefined : resolveClaudeModelId(requestedModel);
        if (model === undefined) throw new Error("A model is required for Claude compaction.");
        this.activeModel = model;
        const compactContext: SessionContext = {
            instructions: original.instructions,
            messages: [
                ...original.messages,
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text:
                                instructions === undefined || instructions.trim().length === 0
                                    ? "/compact"
                                    : `/compact ${instructions}`,
                        },
                    ],
                },
            ],
        };
        let summary = "";
        let usage: SessionUsage | undefined;
        let done: Extract<SessionEvent, { type: "done" }> | undefined;
        for await (const event of this.streamQuery({
            context: compactContext,
            model,
            ...(this.activeEffort === undefined ? {} : { effort: this.activeEffort }),
            ...(signal === undefined ? {} : { abort: signal }),
            compaction: true,
        })) {
            if (event.type === "text_delta") summary += event.delta;
            if (event.type === "token_usage") usage = event.usage;
            if (event.type === "done") done = event;
        }
        if (signal?.aborted) return { status: "cancelled", context: original };
        if (done?.state === "tool_call") {
            return {
                status: "failed",
                kind: "tool_call",
                message: "Claude attempted to call a tool while compacting.",
            };
        }
        if (done?.state === "error") {
            return {
                status: "failed",
                kind: "inference_error",
                message: done.message,
            };
        }
        if (summary.trim().length === 0) {
            return {
                status: "failed",
                kind: "invalid_summary",
                message: "Claude returned an empty compaction summary.",
            };
        }
        if (usage === undefined) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "Claude completed compaction without reporting token usage.",
            };
        }
        const preservedMessages = original.messages.filter((message) => message.role === "system");
        this.context = {
            instructions: original.instructions,
            messages: [
                ...preservedMessages,
                { role: "user", content: [{ type: "text", text: summary }] },
            ],
        };
        return {
            status: "completed",
            summary,
            preservedMessages,
            usage,
            context: this.context,
        };
    }

    destroy(): void {
        this.closeActiveQuery();
    }

    private async *streamRun(
        ctx: Context,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        const signal = ctx.lifetime;
        const requestedModel = request.model ?? this.activeModel ?? this.model;
        const model =
            requestedModel === undefined ? undefined : resolveClaudeModelId(requestedModel);
        if (model === undefined) throw new Error("A model is required for Claude inference.");
        this.activeModel = model;
        const effort = request.effort ?? this.activeEffort;
        this.activeEffort = effort;
        this.context = {
            instructions: request.context.instructions ?? this.context.instructions,
            messages: [...request.context.messages],
        };
        let emptyResponseRetries = 0;
        let completedMidResponseAttempts = 0;
        for (;;) {
            const assistant = new SessionAssistantMessageAccumulator();
            let usage: Extract<SessionEvent, { type: "token_usage" }> | undefined;
            let blockStopped = false;
            let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
            for await (const event of this.streamQuery({
                context: this.context,
                model,
                ...(effort === undefined ? {} : { effort }),
                ...(signal === undefined ? {} : { abort: signal }),
                ...(request.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: request.structuredOutput }),
                maxRetries: Math.max(
                    0,
                    this.resolveInferenceMaxRetries() - completedMidResponseAttempts,
                ),
            })) {
                assistant.add(event);
                if (event.type === "token_usage") {
                    usage = event;
                    continue;
                }
                if (event.type === "block_stop") {
                    blockStopped = true;
                    continue;
                }
                if (event.type === "done") {
                    terminal = event;
                    continue;
                }
                yield event;
            }

            if (terminal === undefined) return;
            if (
                terminal.state === "error" &&
                terminal.providerError?.type === "internal_server_error" &&
                isClaudeMidResponseServerError(terminal.message)
            ) {
                completedMidResponseAttempts += terminal.providerError.diagnostics?.attempts ?? 1;
                terminal = withClaudeErrorAttempts(terminal, completedMidResponseAttempts);
                if (completedMidResponseAttempts <= this.resolveInferenceMaxRetries()) {
                    this.closeActiveQuery();
                    this.sdkSessionId = randomUUID();
                    this.lastQueryToolCalls = [];
                    yield {
                        type: "retrying",
                        attempt: completedMidResponseAttempts,
                        reason: "Claude's response was interrupted by a server error.",
                    };
                    try {
                        await this.retryWait(completedMidResponseAttempts, signal);
                    } catch (delayError) {
                        if (signal?.aborted) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        throw delayError;
                    }
                    continue;
                }
            }
            if (
                terminal.state !== "error" &&
                terminal.state !== "cancelled" &&
                usage?.usage.output === 0
            ) {
                const error = new EmptyResponseError("Claude");
                this.closeActiveQuery();
                this.sdkSessionId = randomUUID();
                this.lastQueryToolCalls = [];
                yield { type: "block_reset" };
                if (usage !== undefined) yield usage;
                if (emptyResponseRetries < this.resolveInferenceMaxRetries()) {
                    emptyResponseRetries += 1;
                    yield {
                        type: "retrying",
                        attempt: emptyResponseRetries,
                        reason: error.message,
                    };
                    try {
                        await this.retryWait(emptyResponseRetries, signal);
                    } catch (delayError) {
                        if (signal?.aborted) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        throw delayError;
                    }
                    continue;
                }
                yield emptyResponseDoneEvent(error, emptyResponseRetries + 1);
                return;
            }

            if (usage !== undefined) yield usage;
            if (terminal.state !== "error" && terminal.state !== "cancelled") {
                const assistantMessage = assistant.message();
                if (assistantMessage !== undefined) {
                    this.context = {
                        instructions: this.context.instructions,
                        messages: [...this.context.messages, assistantMessage],
                    };
                    // The query generated this turn, so it holds it even though no caller sent it.
                    // Leaving it out would let a later edit of this message look like an append.
                    if (this.sentConversation !== undefined) {
                        this.sentConversation = this.context.messages.map(claudeMessageIdentity);
                    }
                }
            }
            if (blockStopped) yield { type: "block_stop" };
            yield terminal;
            return;
        }
    }

    private async *streamQuery(options: {
        abort?: AbortSignal;
        compaction?: boolean;
        context: SessionContext;
        effort?: SessionReasoningEffort;
        maxRetries?: number;
        model: string;
        structuredOutput?: SessionRunRequest["structuredOutput"];
    }): AsyncGenerator<SessionEvent> {
        yield { type: "block_start" };
        const modelConfiguration = this.modelConfigurations?.[options.model];
        const tools = modelConfiguration?.tools ?? this.tools ?? [];
        const systemPrompt = "";
        const configuredContext =
            modelConfiguration === undefined
                ? options.context
                : {
                      instructions: modelConfiguration.instructions,
                      messages: options.context.messages,
                  };
        const queryKey = JSON.stringify({
            compaction: options.compaction === true,
            effort: options.effort,
            model: options.model,
            ...(options.structuredOutput === undefined
                ? {}
                : { structuredOutput: options.structuredOutput }),
            systemPrompt,
            tools,
        });
        // Subsumes the older tail check: the live MCP bridge can close a tool batch only while
        // its results remain at the context tail, and requiring the suffix to be exactly that
        // batch already refuses anything appended after it rather than stranding the open tool.
        const incomingConversation = configuredContext.messages.map(claudeMessageIdentity);
        const delta =
            this.activeQuery === undefined ||
            this.activePromptQueue === undefined ||
            this.activeQueryKey !== queryKey
                ? ({ kind: "restart" } as const)
                : resolveClaudeLiveDelta({
                      incoming: incomingConversation,
                      messages: configuredContext.messages,
                      pendingToolCallIds: this.lastQueryToolCalls.map((call) => call.callId),
                      sent: this.sentConversation,
                  });
        const continuingQuery = delta.kind !== "restart";
        if (!continuingQuery) this.closeActiveQuery();
        const {
            abort: _abort,
            structuredOutput: _structuredOutput,
            ...sdkRequestOptions
        } = options;
        const replay = createClaudeSessionReplay({
            context: configuredContext,
            model: options.model,
            sessionId: this.sdkSessionId,
        });
        const replayableMessageCount = configuredContext.messages.filter(
            (message) => message.role !== "system",
        ).length;
        if (!continuingQuery && replayableMessageCount > 1) {
            // Applied below after the live tool bridge is installed.
        }
        let stream = this.activeQuery;
        let resolveAbort = () => {};
        let invalidatedAfterAbort = false;
        const aborted = new Promise<typeof CLAUDE_QUERY_ABORTED>((resolve) => {
            resolveAbort = () => resolve(CLAUDE_QUERY_ABORTED);
        });
        const invalidateAfterAbort = () => {
            this.closeActiveQuery();
            if (invalidatedAfterAbort) return;
            invalidatedAfterAbort = true;
            this.sdkSessionId = randomUUID();
        };
        const abort = () => {
            resolveAbort();
            if (typeof stream?.interrupt === "function") {
                void Promise.resolve(stream.interrupt()).catch(() => undefined);
            }
            invalidateAfterAbort();
        };
        options.abort?.addEventListener("abort", abort, { once: true });
        const activeTools = new Map<number, Omit<SessionToolCallBlock, "type">>();
        const completedTools: Omit<SessionToolCallBlock, "type">[] = [];
        const activeOutputBlocks = new Map<
            number,
            { type: "text" } | { type: "reasoning"; reasoning: string }
        >();
        // Claude Code runs a server tool inside its own process and answers it there, so Rig
        // reports these calls without ever collecting them as work for the executor.
        const serverToolNames = new Set(claudeSdkBuiltInToolNames(tools));
        const serverToolIdentities = new Map(
            tools.flatMap((tool) =>
                tool.server === undefined || !serverToolNames.has(tool.server.type)
                    ? []
                    : [
                          [
                              tool.server.type,
                              {
                                  name: tool.name,
                                  ...(tool.namespace === undefined
                                      ? {}
                                      : { namespace: tool.namespace }),
                              },
                          ] as const,
                      ],
            ),
        );
        const serverToolCallIds = new Set<string>();
        const completedServerToolResultIds = new Set<string>();
        this.lastQueryToolCalls = [];
        let sawToolCall = false;
        let sawText = false;
        let nativeCompactionCompleted = false;
        let nativeCompactionError: string | undefined;
        let result: SDKResultMessage | undefined;
        let assistantError: SDKAssistantMessageError | undefined;
        let rateLimitInfo: SDKRateLimitInfo | undefined;
        let requestId: string | undefined;
        let attempts = 1;
        let usage = { ...EMPTY_SESSION_USAGE };
        let sawInferenceUsage = false;
        try {
            if (!continuingQuery) {
                const promptQueue = new ClaudePromptQueue();
                const toolBridge = new ClaudeToolBridge();
                const sdkOptions = toClaudeSdkOptions({
                    ...sdkRequestOptions,
                    context: configuredContext,
                    credential: this.credential,
                    env: this.env,
                    maxRetries: options.maxRetries ?? this.resolveInferenceMaxRetries(),
                    ...(this.pathToClaudeCodeExecutable === undefined
                        ? {}
                        : { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }),
                    sessionId: this.sdkSessionId,
                    systemPrompt,
                    ...(options.structuredOutput === undefined
                        ? {}
                        : { structuredOutput: options.structuredOutput }),
                    tools,
                    ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
                    callTool: (toolUseId) => toolBridge.execute(toolUseId),
                });
                if (replayableMessageCount > 1) {
                    delete sdkOptions.sessionId;
                    Object.assign(sdkOptions, replay.options);
                }
                promptQueue.enqueue(replay.message);
                if (options.compaction) promptQueue.close();
                this.activePromptQueue = promptQueue;
                this.activeReplay = replay;
                this.activeToolBridge = toolBridge;
                this.activeQueryKey = queryKey;
                this.activeQuery = this.query({ prompt: promptQueue, options: sdkOptions });
                stream = this.activeQuery;
            } else if (delta.kind === "tool_results") {
                if (this.activeToolBridge?.resolveAll(delta.results) !== true) {
                    throw new Error("Claude could not match every result in the tool batch.");
                }
            } else {
                this.activePromptQueue?.enqueue(
                    createClaudeLivePromptMessage(configuredContext.messages),
                );
            }
            // Only once the turn has actually been handed over does the query hold it.
            this.sentConversation = incomingConversation;
            if (stream === undefined) throw new Error("Claude SDK query was not created.");
            for (;;) {
                const next = await nextClaudeMessage(stream, aborted, options.abort);
                if (next === CLAUDE_QUERY_ABORTED) {
                    invalidateAfterAbort();
                    yield { type: "block_reset" };
                    return;
                }
                if (next.done) {
                    if (options.compaction && nativeCompactionCompleted) break;
                    this.closeActiveQuery();
                    throw new Error("Claude SDK connection closed before returning a result.");
                }
                const message = next.value;
                if (options.abort?.aborted) {
                    invalidateAfterAbort();
                    yield { type: "block_reset" };
                    return;
                }
                if (message.type === "system" && message.subtype === "api_retry") {
                    attempts = Math.max(attempts, message.attempt + 1);
                    yield toClaudeRetryEvent(message);
                    continue;
                }
                if (message.type === "rate_limit_event") {
                    rateLimitInfo = message.rate_limit_info;
                    this.reportAccountUsage(rateLimitInfo);
                    continue;
                }
                if (message.type === "assistant" && message.error !== undefined) {
                    assistantError = message.error;
                    requestId = message.request_id;
                    continue;
                }
                if (
                    options.compaction &&
                    message.type === "system" &&
                    message.subtype === "compact_boundary"
                ) {
                    nativeCompactionCompleted = true;
                    continue;
                }
                if (
                    options.compaction &&
                    message.type === "system" &&
                    message.subtype === "status" &&
                    message.compact_result === "failed"
                ) {
                    nativeCompactionError =
                        message.compact_error ?? "Claude native compaction failed.";
                    continue;
                }
                if (message.type === "user" && Array.isArray(message.message.content)) {
                    for (const block of message.message.content) {
                        if (
                            !isClaudeSdkToolResultBlock(block) ||
                            !serverToolCallIds.has(block.tool_use_id) ||
                            completedServerToolResultIds.has(block.tool_use_id)
                        ) {
                            continue;
                        }
                        yield* emitClaudeServerToolResult(block.tool_use_id, block);
                        completedServerToolResultIds.add(block.tool_use_id);
                    }
                    continue;
                }
                if (message.type === "stream_event") {
                    const event = message.event;
                    if (event.type === "message_start") {
                        usage = toUsage(event.message.usage);
                        sawInferenceUsage = typeof event.message.usage.output_tokens === "number";
                    }
                    if (
                        event.type === "content_block_start" &&
                        event.content_block.type === "text" &&
                        options.structuredOutput === undefined
                    ) {
                        activeOutputBlocks.set(event.index, { type: "text" });
                        sawText = true;
                        yield { type: "text_start" };
                        if (event.content_block.text.length > 0) {
                            yield { type: "text_delta", delta: event.content_block.text };
                        }
                        continue;
                    }
                    if (
                        event.type === "content_block_start" &&
                        event.content_block.type === "thinking"
                    ) {
                        activeOutputBlocks.set(event.index, {
                            type: "reasoning",
                            reasoning: event.content_block.signature,
                        });
                        yield { type: "reasoning_start" };
                        if (event.content_block.thinking.length > 0) {
                            yield {
                                type: "reasoning_delta",
                                delta: event.content_block.thinking,
                            };
                        }
                        continue;
                    }
                    if (
                        event.type === "content_block_start" &&
                        event.content_block.type === "redacted_thinking"
                    ) {
                        activeOutputBlocks.set(event.index, {
                            type: "reasoning",
                            reasoning: event.content_block.data,
                        });
                        yield { type: "reasoning_start" };
                        continue;
                    }
                    if (
                        event.type === "content_block_start" &&
                        (event.content_block.type === "tool_use" ||
                            event.content_block.type === "server_tool_use")
                    ) {
                        if (
                            options.structuredOutput !== undefined &&
                            event.content_block.name === CLAUDE_STRUCTURED_OUTPUT_TOOL_NAME
                        ) {
                            // Leaving it out of activeTools also drops its argument and stop events.
                            continue;
                        }
                        // Claude Code runs a server tool itself and answers it in this same
                        // response, so it is reported like any other call but never becomes work:
                        // it neither stops the turn nor reaches the tool bridge. Anthropic's
                        // native path uses `server_tool_use` for the same class of call.
                        const nativeServer = event.content_block.type === "server_tool_use";
                        const server =
                            nativeServer || serverToolNames.has(event.content_block.name);
                        const wireName = event.content_block.name;
                        const identity = serverToolIdentities.get(wireName);
                        const name = identity?.name ?? wireName;
                        const namespace = identity?.namespace;
                        const vendor = {
                            type: "claude_tool_use" as const,
                            ...(name === wireName ? {} : { wireName }),
                        };
                        if (server) serverToolCallIds.add(event.content_block.id);
                        if (!server) {
                            sawToolCall = true;
                            this.activeToolBridge?.register(event.content_block.id);
                        }
                        activeTools.set(event.index, {
                            callId: event.content_block.id,
                            name,
                            ...(namespace === undefined ? {} : { namespace }),
                            arguments: "",
                            vendor,
                            ...(server ? { server: true as const } : {}),
                        });
                        yield {
                            type: "toolcall_start",
                            callId: event.content_block.id,
                            name,
                            ...(namespace === undefined ? {} : { namespace }),
                            ...(server ? { server: true as const } : {}),
                            vendor,
                        };
                        // server_tool_use carries its full input on the start block; tool_use
                        // streams input_json_delta instead.
                        if (nativeServer) {
                            const input = JSON.stringify(
                                (event.content_block as { input?: unknown }).input ?? {},
                            );
                            activeTools.set(event.index, {
                                callId: event.content_block.id,
                                name,
                                ...(namespace === undefined ? {} : { namespace }),
                                arguments: input,
                                vendor,
                            });
                            if (input.length > 0) {
                                yield {
                                    type: "toolcall_delta",
                                    callId: event.content_block.id,
                                    delta: input,
                                };
                            }
                        }
                        continue;
                    }
                    if (event.type === "content_block_delta") {
                        if (
                            event.delta.type === "text_delta" &&
                            options.structuredOutput === undefined
                        ) {
                            if (activeOutputBlocks.get(event.index)?.type !== "text") {
                                activeOutputBlocks.set(event.index, { type: "text" });
                                yield { type: "text_start" };
                            }
                            sawText = true;
                            yield { type: "text_delta", delta: event.delta.text };
                        } else if (event.delta.type === "thinking_delta") {
                            if (activeOutputBlocks.get(event.index)?.type !== "reasoning") {
                                activeOutputBlocks.set(event.index, {
                                    type: "reasoning",
                                    reasoning: "",
                                });
                                yield { type: "reasoning_start" };
                            }
                            yield { type: "reasoning_delta", delta: event.delta.thinking };
                        } else if (event.delta.type === "signature_delta") {
                            let block = activeOutputBlocks.get(event.index);
                            if (block?.type !== "reasoning") {
                                block = { type: "reasoning", reasoning: "" };
                                activeOutputBlocks.set(event.index, block);
                                yield { type: "reasoning_start" };
                            }
                            block.reasoning += event.delta.signature;
                        } else if (event.delta.type === "input_json_delta") {
                            const block = activeTools.get(event.index);
                            if (block !== undefined) {
                                activeTools.set(event.index, {
                                    ...block,
                                    arguments: block.arguments + event.delta.partial_json,
                                });
                                yield {
                                    type: "toolcall_delta",
                                    callId: block.callId,
                                    delta: event.delta.partial_json,
                                };
                            }
                        }
                    }
                    if (event.type === "message_delta") {
                        usage = mergeUsage(usage, event.usage);
                        if (typeof event.usage.output_tokens === "number") {
                            sawInferenceUsage = true;
                        }
                    }
                    if (event.type === "content_block_stop") {
                        const outputBlock = activeOutputBlocks.get(event.index);
                        if (outputBlock?.type === "text") {
                            yield { type: "text_end" };
                            activeOutputBlocks.delete(event.index);
                        } else if (outputBlock?.type === "reasoning") {
                            yield {
                                type: "reasoning_end",
                                ...(outputBlock.reasoning.length === 0
                                    ? {}
                                    : { reasoning: outputBlock.reasoning }),
                            };
                            activeOutputBlocks.delete(event.index);
                        }
                        const block = activeTools.get(event.index);
                        if (block !== undefined) {
                            yield {
                                type: "toolcall_end",
                                callId: block.callId,
                                arguments: block.arguments,
                            };
                            completedTools.push(block);
                            activeTools.delete(event.index);
                            // Claude Code answers built-ins out of band and does not stream their
                            // results as content blocks here. A later text block is the model's
                            // synthesis, not the tool payload, so server calls end without a
                            // toolcall_result triple unless a dedicated result block arrives.
                        }
                    }
                    // Anthropic-native server tools (when the SDK surfaces them) arrive as their
                    // own content blocks with a tool_use_id that pairs to the call above.
                    if (
                        event.type === "content_block_start" &&
                        isClaudeServerToolResultBlock(event.content_block)
                    ) {
                        const callId = event.content_block.tool_use_id;
                        if (!completedServerToolResultIds.has(callId)) {
                            yield* emitClaudeServerToolResult(callId, event.content_block);
                            completedServerToolResultIds.add(callId);
                        }
                        continue;
                    }
                    if (event.type === "message_stop" && sawToolCall) {
                        yield* closeClaudeOutputBlocks(activeOutputBlocks);
                        this.lastQueryToolCalls = completedTools.filter(
                            (call) => call.server !== true,
                        );
                        if (sawInferenceUsage) yield { type: "token_usage", usage };
                        yield { type: "block_stop" };
                        yield {
                            type: "done",
                            state: "tool_call",
                            tokens: { input: usage.input, output: usage.output },
                        };
                        return;
                    }
                    continue;
                }
                if (message.type === "result") {
                    result = message;
                    break;
                }
            }
            if (nativeCompactionError !== undefined) {
                throw new Error(nativeCompactionError);
            }
            if (options.compaction && nativeCompactionCompleted) {
                const compactResultUsage =
                    result === undefined ? undefined : toAggregateModelUsage(result.modelUsage);
                if (!sawInferenceUsage && compactResultUsage !== undefined) {
                    usage = compactResultUsage;
                    sawInferenceUsage = true;
                }
                const summary = this.activeReplay?.compactionSummary();
                if (summary === undefined) {
                    throw new Error(
                        "Claude SDK compacted the session without persisting a summary.",
                    );
                }
                this.closeActiveQuery();
                yield { type: "text_start" };
                yield { type: "text_delta", delta: summary };
                yield { type: "text_end" };
                if (sawInferenceUsage) yield { type: "token_usage", usage };
                yield {
                    type: "done",
                    state: "normal",
                    tokens: { input: usage.input, output: usage.output },
                };
                return;
            }
            if (result === undefined && !sawToolCall) {
                throw new Error("Claude SDK finished without returning a result.");
            }
            if (result !== undefined) {
                // SDK result usage is accumulated across every inference in the active query.
                // It is only a valid fallback for the query's first inference. Continued
                // inferences must use their message_delta usage or remain unreported.
                if (
                    !sawInferenceUsage &&
                    !continuingQuery &&
                    typeof result.usage.output_tokens === "number"
                ) {
                    usage = toUsage(result.usage);
                    sawInferenceUsage = true;
                }
                if (
                    options.structuredOutput !== undefined &&
                    result.subtype === "success" &&
                    !result.is_error
                ) {
                    if (result.structured_output === undefined) {
                        throw new Error(
                            "Claude completed structured output without returning a value.",
                        );
                    }
                    yield {
                        type: "text_start",
                    };
                    yield {
                        type: "text_delta",
                        delta: JSON.stringify(result.structured_output),
                    };
                    yield { type: "text_end" };
                } else if (!sawText && result.subtype === "success" && result.result.length > 0) {
                    yield { type: "text_start" };
                    yield { type: "text_delta", delta: result.result };
                    yield { type: "text_end" };
                }
                if (result.subtype !== "success" || result.is_error) {
                    const message =
                        result.subtype === "success"
                            ? result.result.trim() || "Claude returned an unsuccessful result."
                            : claudeResultErrorMessage(result);
                    const providerError = classifyClaudeError({
                        ...(assistantError === undefined ? {} : { assistantError }),
                        attempts,
                        message,
                        ...(rateLimitInfo === undefined ? {} : { rateLimitInfo }),
                        ...(requestId === undefined ? {} : { requestId }),
                    });
                    this.closeActiveQuery();
                    yield { type: "block_reset" };
                    yield {
                        type: "done",
                        state: "error",
                        kind:
                            providerError.type === "out_of_tokens"
                                ? "billing_error"
                                : providerError.type === "server_overloaded" ||
                                    providerError.type === "internal_server_error"
                                  ? "internal_error"
                                  : "unknown",
                        message,
                        providerError,
                    };
                    return;
                }
            }
            this.lastQueryToolCalls = completedTools.filter((call) => call.server !== true);
            yield* closeClaudeOutputBlocks(activeOutputBlocks);
            if (sawInferenceUsage) yield { type: "token_usage", usage };
            yield { type: "block_stop" };
            yield {
                type: "done",
                state: sawToolCall ? "tool_call" : "normal",
                tokens: { input: usage.input, output: usage.output },
            };
        } catch (error) {
            if (options.abort?.aborted) invalidateAfterAbort();
            else this.closeActiveQuery();
            yield { type: "block_reset" };
            if (options.abort?.aborted) return;
            const rawMessage = error instanceof Error ? error.message : String(error);
            const message = rawMessage.trim() || "Claude inference failed with an unknown error.";
            const providerError = classifyClaudeError({
                ...(assistantError === undefined ? {} : { assistantError }),
                attempts,
                error,
                message,
                ...(rateLimitInfo === undefined ? {} : { rateLimitInfo }),
                ...(requestId === undefined ? {} : { requestId }),
            });
            yield {
                type: "done",
                state: "error",
                kind:
                    providerError.type === "out_of_tokens"
                        ? "billing_error"
                        : providerError.type === "server_overloaded" ||
                            providerError.type === "internal_server_error"
                          ? "internal_error"
                          : "unknown",
                message,
                providerError,
            };
        } finally {
            options.abort?.removeEventListener("abort", abort);
        }
    }

    private closeActiveQuery(): void {
        this.activeToolBridge?.close();
        this.activeToolBridge = undefined;
        this.activePromptQueue?.close();
        this.activePromptQueue = undefined;
        this.activeQuery?.close();
        this.activeQuery = undefined;
        this.activeQueryKey = undefined;
        this.sentConversation = undefined;
        this.activeReplay = undefined;
    }
}

async function nextClaudeMessage(
    stream: ReturnType<ClaudeSdkQuery>,
    aborted: Promise<typeof CLAUDE_QUERY_ABORTED>,
    signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<typeof stream.next>> | typeof CLAUDE_QUERY_ABORTED> {
    return signal?.aborted ? CLAUDE_QUERY_ABORTED : Promise.race([stream.next(), aborted]);
}

function toUsage(usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
}): SessionUsage {
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const input = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
    const output = usage.output_tokens ?? 0;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output,
    };
}

function mergeUsage(
    current: SessionUsage,
    update: {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
    },
): SessionUsage {
    const cacheRead = update.cache_read_input_tokens ?? current.cacheRead;
    const cacheWrite = update.cache_creation_input_tokens ?? current.cacheWrite;
    const input =
        update.input_tokens === undefined || update.input_tokens === null
            ? current.input
            : update.input_tokens + cacheRead + cacheWrite;
    const output = update.output_tokens ?? current.output;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output,
    };
}

function toAggregateModelUsage(
    modelUsage: SDKResultMessage["modelUsage"],
): SessionUsage | undefined {
    const entries = Object.values(modelUsage);
    if (entries.length === 0) return undefined;
    const cacheRead = entries.reduce((total, usage) => total + usage.cacheReadInputTokens, 0);
    const cacheWrite = entries.reduce((total, usage) => total + usage.cacheCreationInputTokens, 0);
    const input =
        entries.reduce((total, usage) => total + usage.inputTokens, 0) + cacheRead + cacheWrite;
    const output = entries.reduce((total, usage) => total + usage.outputTokens, 0);
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output,
    };
}

function emptyStream(): SessionStream {
    async function* stream(): AsyncGenerator<SessionEvent> {}
    return stream();
}

function withClaudeErrorAttempts(
    event: Extract<SessionEvent, { type: "done"; state: "error" }>,
    attempts: number,
): Extract<SessionEvent, { type: "done"; state: "error" }> {
    if (event.providerError === undefined) return event;
    return {
        ...event,
        providerError: {
            ...event.providerError,
            diagnostics: {
                ...event.providerError.diagnostics,
                attempts,
            },
        },
    };
}

/**
 * Anthropic content blocks that carry a provider-owned tool outcome.
 *
 * Claude Code's built-in path rarely surfaces these; the native Messages path does for web search
 * and similar server tools. The block is identified by type and `tool_use_id`, not by name.
 */
function isClaudeServerToolResultBlock(
    block: unknown,
): block is { type: string; tool_use_id: string; content?: unknown } {
    if (typeof block !== "object" || block === null) return false;
    if (!("type" in block) || typeof block.type !== "string") return false;
    if (!block.type.endsWith("_tool_result") && block.type !== "web_search_tool_result") {
        return false;
    }
    return "tool_use_id" in block && typeof block.tool_use_id === "string";
}

function isClaudeSdkToolResultBlock(
    block: unknown,
): block is { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean } {
    return (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result" &&
        "tool_use_id" in block &&
        typeof block.tool_use_id === "string"
    );
}

function* emitClaudeServerToolResult(
    callId: string,
    outputBlock: { content?: unknown; is_error?: boolean },
): Generator<SessionEvent> {
    const result =
        typeof outputBlock.content === "string"
            ? outputBlock.content
            : JSON.stringify(outputBlock.content ?? null);
    const vendor = { outputBlock: JSON.stringify(outputBlock) };
    yield { type: "toolcall_result_start", callId, vendor };
    if (result.length > 0) yield { type: "toolcall_result_delta", callId, delta: result };
    yield {
        type: "toolcall_result_end",
        callId,
        content: [{ type: "text", text: result }],
        ...(outputBlock.is_error === undefined ? {} : { isError: outputBlock.is_error }),
    };
}

function* closeClaudeOutputBlocks(
    blocks: Map<number, { type: "text" } | { type: "reasoning"; reasoning: string }>,
): Generator<SessionEvent> {
    for (const [, block] of blocks) {
        if (block.type === "text") {
            yield { type: "text_end" };
        } else {
            yield {
                type: "reasoning_end",
                ...(block.reasoning.length === 0 ? {} : { reasoning: block.reasoning }),
            };
        }
    }
    blocks.clear();
}
