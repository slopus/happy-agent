import { randomUUID } from "node:crypto";

import type OpenAI from "openai";

import { BaseSession } from "@/core/BaseSession.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import {
    EmptyResponseError,
    emptyResponseDoneEvent,
    isEmptyResponseError,
} from "@/core/EmptyResponseError.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { responsesServerToolName } from "@/protocol/responses/toResponsesToolDefinitions.js";
import { isBedrockCredential, type CodexProviderCredential } from "@/vendors/VendorCredential.js";
import {
    classifyCodexError,
    classifyCodexProviderError,
    codexErrorMessage,
} from "@/vendors/codex/errors/codexErrors.js";
import { codexModelsShareConfiguration } from "@/vendors/codex/impl/codexModelsShareConfiguration.js";
import {
    type CodexCompactionMetadata,
    collectCodexCompaction,
    createCodexCompactionRequest,
    fitCodexCompactionRequest,
    preserveCodexCompactionMessages,
    preserveCodexLocalCompactionMessages,
} from "@/vendors/codex/impl/codexCompaction.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import { createCodexClient } from "@/vendors/codex/impl/createCodexClient.js";
import { createCodexClientMetadata } from "@/vendors/codex/impl/createCodexClientMetadata.js";
import { CodexSseConnection } from "@/vendors/codex/impl/CodexSseConnection.js";
import { CodexTurnState } from "@/vendors/codex/impl/CodexTurnState.js";
import { CodexWebSocketConnection } from "@/vendors/codex/impl/CodexWebSocketConnection.js";
import {
    parseCodexServiceTier,
    type CodexServiceTier,
} from "@/vendors/codex/impl/codexServiceTier.js";
import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { createCodexModelSwitchMessage } from "@/vendors/codex/impl/createCodexModelSwitchMessage.js";
import { getCodexContextSuffix } from "@/vendors/codex/impl/getCodexContextSuffix.js";
import { getCodexModelProperties } from "@/vendors/codex/impl/getCodexModelProperties.js";
import { getCodexTurnKey } from "@/vendors/codex/impl/getCodexTurnKey.js";
import { isCodexContextWindowError } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexPreviousResponseNotFoundError } from "@/vendors/codex/errors/codexErrors.js";
import { readCodexMissingToolOutputCallId } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexUnauthorizedError } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexWebSocketUnavailableError } from "@/vendors/codex/errors/codexErrors.js";
import { isRetryableCodexStreamError } from "@/vendors/codex/errors/codexErrors.js";
import { recoverCodexUnauthorizedCredential } from "@/vendors/codex/impl/recoverCodexUnauthorizedCredential.js";
import { resolveCodexReasoningEffort } from "@/vendors/codex/impl/resolveCodexReasoningEffort.js";
import { resolveCodexSessionModelId } from "@/vendors/codex/impl/resolveCodexSessionModelId.js";
import { BEDROCK_DEFAULT_REGION } from "@/vendors/bedrock/impl/bedrockConstants.js";
import { settleCodexToolSearch } from "@/vendors/codex/impl/settleCodexToolSearch.js";
import { isCodexToolSearchDefinition } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import {
    resolveCodexStreamIdleTimeout,
    waitForCodexCompactionRetry,
    waitForCodexRetry,
} from "@/vendors/codex/impl/codexRetry.js";
import { setCodexRequestKind } from "@/vendors/codex/impl/setCodexRequestKind.js";
import {
    context_checkpoint_compaction_instructions,
    context_checkpoint_summary_prefix,
} from "@/vendors/codex/prompts/context_checkpoint_compaction_instructions.js";
import type { CodexTransport } from "@/vendors/codex/impl/codexConstants.js";
import type { Context } from "@steve.kite/stdlib";

const CODEX_COMPACTION_MAX_RETRIES = 2;
const CODEX_TOOL_SEARCH_MAX_ROUNDS = 4;

export interface CodexSessionOptions extends InferenceRetryOptions {
    instructions: string;
    credential: CodexProviderCredential;
    endpoint: string;
    installationId: string;
    model?: string;
    modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
    parallelToolCalls?: boolean;
    region?: string;
    streamIdleTimeoutMs?: number;
    tools?: readonly SessionTool[];
    transport?: CodexTransport;
    userAgent: string;
}

export class CodexSession extends BaseSession {
    credential: CodexProviderCredential;
    readonly endpoint: string;
    readonly model: string | undefined;
    readonly parallelToolCalls: boolean | undefined;
    readonly region: string;
    readonly streamIdleTimeoutMs: number;
    readonly tools: readonly SessionTool[];
    readonly transport: CodexTransport;
    readonly userAgent: string;

    private activeConfiguration: SessionModelConfiguration;
    private activeEffort: SessionReasoningEffort | undefined;
    private activeModel: string | undefined;
    private client: OpenAI | undefined;
    private context: SessionContext;
    private forceSse = false;
    private readonly installationId: string;
    private readonly modelConfigurations = new Map<string, SessionModelConfiguration>();
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #emptyResponseRetryWait: NonNullable<InferenceRetryOptions["waitForInferenceRetry"]>;
    private turnId = randomUUID();
    private turnKey: string | undefined;
    private readonly turnState = new CodexTurnState();
    private windowId = randomUUID();
    private readonly sseConnection: CodexSseConnection;
    private readonly websocketConnection: CodexWebSocketConnection;

    constructor(id: string, options: CodexSessionOptions) {
        super(id);
        this.credential = options.credential;
        this.endpoint = options.endpoint;
        this.installationId = options.installationId;
        this.model = options.model;
        this.parallelToolCalls = options.parallelToolCalls;
        this.region = options.region?.trim() || BEDROCK_DEFAULT_REGION;
        this.activeModel = options.model;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#emptyResponseRetryWait =
            options.waitForInferenceRetry ??
            ((attempt, signal) => waitForCodexRetry(attempt, undefined, signal));
        this.streamIdleTimeoutMs = resolveCodexStreamIdleTimeout(options.streamIdleTimeoutMs);
        this.tools = options.tools ?? [];
        this.transport = options.transport ?? "auto";
        this.userAgent = options.userAgent;

        const baseConfiguration = cloneConfiguration({
            instructions: options.instructions,
            tools: this.tools,
        });
        for (const [model, configuration] of Object.entries(options.modelConfigurations ?? {})) {
            this.modelConfigurations.set(
                resolveCodexSessionModelId(model, isBedrockCredential(this.credential)),
                cloneConfiguration(configuration),
            );
        }
        if (options.model !== undefined && !this.modelConfigurations.has(options.model)) {
            this.modelConfigurations.set(options.model, baseConfiguration);
        }
        this.activeConfiguration =
            (options.model === undefined
                ? undefined
                : this.modelConfigurations.get(options.model)) ?? baseConfiguration;
        this.context = { instructions: this.activeConfiguration.instructions, messages: [] };

        this.sseConnection = new CodexSseConnection({
            bedrock: () => isBedrockCredential(this.credential),
            client: () => this.resolveClient(),
            idleTimeoutMs: this.streamIdleTimeoutMs,
            turnState: this.turnState,
            windowId: () => this.windowId,
        });
        this.websocketConnection = new CodexWebSocketConnection({
            client: () => this.resolveClient(),
            headers: () => this.websocketHeaders(),
            idleTimeoutMs: this.streamIdleTimeoutMs,
            turnState: this.turnState,
        });
    }

    get inferenceMaxRetries(): number {
        return this.#resolveInferenceMaxRetries();
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        if (ctx.lifetime?.aborted) return cancelledStream();
        return this.streamRun(ctx, request);
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const signal = ctx.lifetime;
        if (signal?.aborted) return { status: "cancelled", context: options.context };
        const requestedModel = options.model ?? this.activeModel ?? this.model;
        const model =
            requestedModel === undefined
                ? undefined
                : resolveCodexSessionModelId(requestedModel, isBedrockCredential(this.credential));
        if (model === undefined) throw new Error("A model is required for Codex compaction.");
        this.activeModel = model;
        const effort = resolveCodexReasoningEffort(model, this.activeEffort);
        this.beginTurn(`compaction:${randomUUID()}`);
        return this.compactContext(
            this.activeConfiguration,
            options.context,
            model,
            effort,
            {
                trigger: "manual",
                reason: "user_requested",
                implementation: "responses_compaction_v2",
                phase: "standalone_turn",
                strategy: "memento",
            },
            signal,
        );
    }

    destroy(): void {
        this.websocketConnection.close("session destroyed");
        this.client = undefined;
    }

    private async compactContext(
        configuration: SessionModelConfiguration,
        requested: SessionCompactionOptions["context"],
        model: string,
        effort: SessionReasoningEffort,
        metadata: CodexCompactionMetadata,
        signal?: AbortSignal,
    ): Promise<SessionCompaction> {
        const context: SessionContext = {
            instructions: requested.instructions,
            messages: structuredClone([...requested.messages]),
        };
        if (signal?.aborted) return { status: "cancelled", context };
        // Compaction summarizes context that already exists, so it has nothing to search for. It
        // never adds the server tools a turn gets, and it drops any it was handed: declaring one
        // here would let the provider run work during a summary, and would make a name Rig can
        // read back as provider-run appear in a request whose replies are only ever a summary.
        const compactionConfiguration: SessionModelConfiguration = {
            ...configuration,
            tools: (configuration.tools ?? []).filter(
                (tool) => tool.server === undefined && tool.defer !== true,
            ),
        };
        if (isBedrockCredential(this.credential)) {
            return this.compactBedrockContext(
                context,
                compactionConfiguration,
                model,
                effort,
                { ...metadata, implementation: "responses" },
                signal,
            );
        }
        const basePayload = createCodexCompactionRequest(
            this.createRequest(context, compactionConfiguration, model, effort),
            metadata,
        );
        const contextWindow = getCodexModelProperties(model)?.contextWindow ?? 272_000;
        let fittedContextWindow = contextWindow;
        let payload = fitCodexCompactionRequest(
            basePayload,
            compactionConfiguration.tools ?? [],
            fittedContextWindow,
        );
        let useSse = this.transport === "sse" || (this.transport === "auto" && this.forceSse);
        let contextWindowRetries = 0;
        let previousResponseRecoveries = 0;
        let transportRetries = 0;
        let unauthorizedRecoveryStep = 0;
        const maxRetries = Math.min(this.inferenceMaxRetries, CODEX_COMPACTION_MAX_RETRIES);

        for (;;) {
            try {
                const stream = useSse
                    ? await this.sseConnection.stream({
                          model,
                          request: payload,
                          tools: compactionConfiguration.tools ?? [],
                          ...(signal === undefined ? {} : { signal }),
                      })
                    : this.websocketConnection.stream({
                          request: payload,
                          tools: compactionConfiguration.tools ?? [],
                          ...(signal === undefined ? {} : { signal }),
                      });
                const collected = await collectCodexCompaction(
                    stream,
                    signal === undefined ? {} : { signal },
                );
                if (signal?.aborted) return { status: "cancelled", context: this.context };
                const compaction = {
                    role: "compaction" as const,
                    content: null,
                    encryptedContent: collected.item.encrypted_content,
                };
                const preservedMessages = preserveCodexCompactionMessages(context.messages);
                this.context = {
                    instructions: context.instructions,
                    messages: [...preservedMessages, compaction],
                };
                this.windowId = randomUUID();
                this.websocketConnection.clearResponseChain();
                return {
                    status: "completed",
                    compaction,
                    preservedMessages,
                    usage: collected.usage,
                    context: this.context,
                };
            } catch (error) {
                if (!useSse) this.websocketConnection.reset("compaction did not complete");
                if (signal?.aborted) return { status: "cancelled", context: this.context };
                if (isCodexUnauthorizedError(error)) {
                    const recovered = await recoverCodexUnauthorizedCredential(
                        this.credential,
                        unauthorizedRecoveryStep,
                    );
                    if (recovered !== undefined) {
                        unauthorizedRecoveryStep += 1;
                        this.replaceCredential(recovered);
                        continue;
                    }
                }
                if (
                    !useSse &&
                    previousResponseRecoveries < 1 &&
                    isCodexPreviousResponseNotFoundError(error)
                ) {
                    previousResponseRecoveries += 1;
                    continue;
                }
                if (
                    isCodexContextWindowError(error) &&
                    contextWindowRetries < CODEX_COMPACTION_MAX_RETRIES
                ) {
                    contextWindowRetries += 1;
                    fittedContextWindow = Math.floor(fittedContextWindow * 0.9);
                    payload = fitCodexCompactionRequest(
                        basePayload,
                        compactionConfiguration.tools ?? [],
                        fittedContextWindow,
                    );
                    transportRetries = 0;
                    continue;
                }
                if (
                    isRetryableCodexStreamError(error) &&
                    (useSse || !isCodexWebSocketUnavailableError(error)) &&
                    transportRetries < maxRetries
                ) {
                    transportRetries += 1;
                    try {
                        await waitForCodexCompactionRetry(transportRetries, signal);
                    } catch (delayError) {
                        if (signal?.aborted) return { status: "cancelled", context: this.context };
                        throw delayError;
                    }
                    continue;
                }
                if (
                    this.transport === "auto" &&
                    !useSse &&
                    (isRetryableCodexStreamError(error) || isCodexWebSocketUnavailableError(error))
                ) {
                    this.forceSse = true;
                    useSse = true;
                    transportRetries = 0;
                    continue;
                }
                throw error;
            }
        }
    }

    private async compactBedrockContext(
        context: SessionContext,
        configuration: SessionModelConfiguration,
        model: string,
        effort: SessionReasoningEffort,
        metadata: CodexCompactionMetadata,
        signal?: AbortSignal,
    ): Promise<SessionCompaction> {
        const compactionContext: SessionContext = {
            instructions: context.instructions,
            messages: [
                ...context.messages,
                {
                    role: "user",
                    content: [{ type: "text", text: context_checkpoint_compaction_instructions }],
                },
            ],
        };
        const compactionConfiguration: SessionModelConfiguration = {
            instructions: configuration.instructions,
            tools: [],
        };
        const basePayload = this.createRequest(
            compactionContext,
            compactionConfiguration,
            model,
            effort,
        );
        const contextWindow = getCodexModelProperties(model)?.contextWindow ?? 272_000;
        let fittedContextWindow = contextWindow;
        let payload = fitCodexCompactionRequest(basePayload, [], fittedContextWindow);
        setCodexRequestKind(payload, "compaction", metadata);
        let contextWindowRetries = 0;
        let retries = 0;
        const maxRetries = Math.min(this.inferenceMaxRetries, CODEX_COMPACTION_MAX_RETRIES);
        for (;;) {
            try {
                const stream = await this.sseConnection.stream({
                    model,
                    request: payload,
                    tools: [],
                    ...(signal === undefined ? {} : { signal }),
                });
                const mapped = mapOpenAIResponseStream(stream, {
                    failureMessage: `${model} failed to compact the conversation.`,
                    requireTerminalEvent: true,
                    vendor: "codex",
                    ...(signal === undefined ? {} : { signal }),
                });
                let result: Awaited<ReturnType<typeof mapped.next>>["value"] | undefined;
                for (;;) {
                    const next = await mapped.next();
                    if (next.done) {
                        result = next.value;
                        break;
                    }
                }
                if (signal?.aborted) return { status: "cancelled", context: this.context };
                if (result === undefined || !("assistantText" in result)) {
                    throw new Error("Bedrock compaction completed without a summary.");
                }
                const summary = result.assistantText.trim();
                if (summary.length === 0)
                    throw new Error("Bedrock compaction returned an empty summary.");
                const preservedMessages = preserveCodexLocalCompactionMessages(context.messages);
                this.context = {
                    instructions: context.instructions,
                    messages: [
                        ...preservedMessages,
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `${context_checkpoint_summary_prefix}\n${summary}`,
                                },
                            ],
                        },
                    ],
                };
                this.windowId = randomUUID();
                this.websocketConnection.clearResponseChain();
                return {
                    status: "completed",
                    summary,
                    preservedMessages,
                    usage: result.usage,
                    context: this.context,
                };
            } catch (error) {
                if (signal?.aborted) return { status: "cancelled", context: this.context };
                if (
                    isCodexContextWindowError(error) &&
                    contextWindowRetries < CODEX_COMPACTION_MAX_RETRIES
                ) {
                    contextWindowRetries += 1;
                    fittedContextWindow = Math.floor(fittedContextWindow * 0.9);
                    payload = fitCodexCompactionRequest(basePayload, [], fittedContextWindow);
                    setCodexRequestKind(payload, "compaction", metadata);
                    retries = 0;
                    continue;
                }
                if (isRetryableCodexStreamError(error) && retries < maxRetries) {
                    retries += 1;
                    await waitForCodexCompactionRetry(retries, signal);
                    continue;
                }
                throw error;
            }
        }
    }

    private async *streamRun(
        ctx: Context,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        const signal = ctx.lifetime;
        const requestedModel = request.model ?? this.activeModel;
        const model =
            requestedModel === undefined
                ? undefined
                : resolveCodexSessionModelId(requestedModel, isBedrockCredential(this.credential));
        if (model === undefined) throw new Error("A model is required for Codex inference.");
        const configuration = this.resolveConfiguration(model);
        const effort = resolveCodexReasoningEffort(model, request.effort);
        const serviceTier = parseCodexServiceTier(request.serviceTier);
        const modelChanged = this.activeModel !== undefined && this.activeModel !== model;
        // The caller's rebuilt context is authoritative. The session's own copy is preferred only
        // when the rebuilt context extends it, because that copy retains provider state such as
        // encrypted reasoning that the caller's transcript does not carry.
        const rebuilt = structuredClone([...request.context.messages]);
        const appended = getCodexContextSuffix(this.context.messages, rebuilt);
        const nextTurnKey = getCodexTurnKey(request.context.messages);
        if (this.turnKey !== nextTurnKey) this.beginTurn(nextTurnKey);

        const history = appended === undefined ? [] : this.context.messages;
        const newMessages = appended ?? rebuilt;
        const messages: SessionMessage[] = [
            ...history,
            ...(modelChanged ? [createCodexModelSwitchMessage(configuration.instructions)] : []),
            ...newMessages,
        ];
        this.context = {
            instructions: request.context.instructions ?? configuration.instructions,
            messages,
        };
        const turnContextPrefixLength = this.context.messages.length;
        const carriedContent: import("@/core/SessionContext.js").SessionAssistantBlock[] = [];
        const internalToolSearchCallIds = new Set<string>();
        let toolSearchRounds = 0;
        this.activeConfiguration = configuration;
        this.activeEffort = effort;
        this.activeModel = model;

        let useSse = this.transport === "sse" || (this.transport === "auto" && this.forceSse);
        let transportRetries = 0;
        let reportedAttempt = 0;
        let previousResponseRecoveries = 0;
        let missingToolOutputRecoveries = 0;
        let unauthorizedRecoveryStep = 0;

        for (;;) {
            const turnTools = codexTurnTools(
                configuration.tools ?? [],
                isBedrockCredential(this.credential),
            );
            const clientToolSearchTool = turnTools.find(
                (tool) => tool.server?.type === "tool_search" && tool.server.execution === "client",
            );
            const clientToolSearchEnabled = clientToolSearchTool !== undefined;
            const turnConfiguration = { ...configuration, tools: turnTools };
            const payload = this.createRequest(
                this.context,
                turnConfiguration,
                model,
                effort,
                serviceTier,
                request.structuredOutput,
            );
            const serverToolNames = new Set(
                turnTools.flatMap((tool) => {
                    const name = responsesServerToolName(tool);
                    return name === undefined ? [] : [name];
                }),
            );
            const serverToolDisplayNames = new Map(
                turnTools.flatMap((tool) => {
                    const name = responsesServerToolName(tool);
                    return name === undefined ? [] : [[name, tool.name] as const];
                }),
            );
            const serverToolDisplayNamespaces = new Map(
                turnTools.flatMap((tool) => {
                    const name = responsesServerToolName(tool);
                    return name === undefined || tool.namespace === undefined
                        ? []
                        : [[name, tool.namespace] as const];
                }),
            );
            const attemptUsage: Extract<SessionEvent, { type: "token_usage" }>[] = [];
            yield { type: "block_start" };
            try {
                const responseStream = useSse
                    ? await this.sseConnection.stream({
                          model,
                          request: payload,
                          tools: turnTools,
                          ...(signal === undefined ? {} : { signal }),
                      })
                    : this.websocketConnection.stream({
                          request: payload,
                          tools: turnTools,
                          ...(signal === undefined ? {} : { signal }),
                      });
                const mapped = mapOpenAIResponseStream(responseStream, {
                    failureMessage: `${model} failed to generate a response.`,
                    serverToolNames,
                    serverToolDisplayNames,
                    serverToolDisplayNamespaces,
                    requireTerminalEvent: true,
                    vendor: "codex",
                    ...(signal === undefined ? {} : { signal }),
                });
                let result: Awaited<ReturnType<typeof mapped.next>>["value"] | undefined;
                let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
                for (;;) {
                    const next = await mapped.next();
                    if (next.done) {
                        result = next.value;
                        break;
                    }
                    const event = next.value;
                    if (event.type === "done") {
                        terminal = event;
                        continue;
                    }
                    if (event.type === "token_usage") {
                        attemptUsage.push(event);
                        continue;
                    }
                    if (
                        clientToolSearchEnabled &&
                        event.type === "toolcall_start" &&
                        event.name === "tool_search"
                    ) {
                        internalToolSearchCallIds.add(event.callId);
                        // Client-executed discovery is still provider-owned from Agent Base's
                        // perspective: Codex settles it below and the caller never executes it.
                        yield {
                            ...event,
                            name: clientToolSearchTool?.name ?? event.name,
                            ...(clientToolSearchTool?.namespace === undefined
                                ? {}
                                : { namespace: clientToolSearchTool.namespace }),
                            server: true,
                        };
                        continue;
                    }
                    if (
                        (event.type === "toolcall_delta" || event.type === "toolcall_end") &&
                        internalToolSearchCallIds.has(event.callId)
                    ) {
                        yield event;
                        continue;
                    }
                    yield event;
                }

                if (signal?.aborted && terminal === undefined) {
                    if (!useSse) this.websocketConnection.reset("request aborted");
                    yield { type: "block_reset" };
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                if (terminal?.state === "error") {
                    if (!useSse) this.websocketConnection.reset("response failed");
                    yield { type: "block_reset" };
                    yield terminal;
                    return;
                }
                if (
                    result !== undefined &&
                    "outputTokensReported" in result &&
                    result.outputTokensReported &&
                    result.usage.output === 0
                ) {
                    throw new EmptyResponseError("Codex");
                }
                const settled =
                    result !== undefined && "assistantText" in result
                        ? settleCodexToolSearch(result, turnTools)
                        : undefined;
                if (settled !== undefined) result = settled.result;
                for (const settlement of settled?.settlements ?? []) {
                    yield {
                        type: "toolcall_result_start",
                        callId: settlement.call.callId,
                        vendor: { outputItem: settlement.outputItem },
                    };
                    yield {
                        type: "toolcall_result_end",
                        callId: settlement.call.callId,
                        content: [],
                    };
                }
                for (const event of attemptUsage) yield event;
                if (result !== undefined && "assistantText" in result) {
                    if (settled?.settled === true && result.toolCalls.length === 0) {
                        toolSearchRounds += 1;
                        if (toolSearchRounds > CODEX_TOOL_SEARCH_MAX_ROUNDS) {
                            yield { type: "block_stop" };
                            yield {
                                type: "done",
                                state: "error",
                                kind: "internal_error",
                                message:
                                    "Codex exceeded the provider-internal tool discovery limit.",
                            };
                            return;
                        }
                        carriedContent.push(...result.message.content);
                        this.context = {
                            instructions: this.context.instructions,
                            messages: [...this.context.messages, result.message],
                        };
                        yield { type: "block_stop" };
                        continue;
                    }
                    const assistantMessage = {
                        role: "assistant" as const,
                        content: [...carriedContent, ...result.message.content],
                    };
                    if (assistantMessage.content.length > 0) {
                        this.context = {
                            instructions: this.context.instructions,
                            messages: [
                                ...this.context.messages.slice(0, turnContextPrefixLength),
                                assistantMessage,
                            ],
                        };
                    }
                }
                yield { type: "block_stop" };
                if (terminal !== undefined) yield terminal;
                return;
            } catch (error) {
                if (!useSse) this.websocketConnection.reset("stream did not complete");
                yield { type: "block_reset" };
                for (const event of attemptUsage) yield event;
                if (signal?.aborted) {
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                const displayMessage = codexErrorMessage(error, message);
                if (isCodexUnauthorizedError(error)) {
                    const recovered = await recoverCodexUnauthorizedCredential(
                        this.credential,
                        unauthorizedRecoveryStep,
                    );
                    if (recovered !== undefined) {
                        unauthorizedRecoveryStep += 1;
                        this.replaceCredential(recovered);
                        continue;
                    }
                }
                const missingToolOutputCallId = readCodexMissingToolOutputCallId(error);
                if (
                    !useSse &&
                    missingToolOutputCallId !== undefined &&
                    missingToolOutputRecoveries < 1 &&
                    codexRequestHasToolOutput(payload, missingToolOutputCallId)
                ) {
                    missingToolOutputRecoveries += 1;
                    reportedAttempt += 1;
                    yield {
                        type: "retrying",
                        attempt: reportedAttempt,
                        reason: "Codex lost a tool result; replaying full context.",
                    };
                    continue;
                }
                if (
                    !useSse &&
                    previousResponseRecoveries < 1 &&
                    isCodexPreviousResponseNotFoundError(error)
                ) {
                    previousResponseRecoveries += 1;
                    reportedAttempt += 1;
                    yield {
                        type: "retrying",
                        attempt: reportedAttempt,
                        reason: "Previous Codex response was unavailable; replaying full context.",
                    };
                    continue;
                }
                if (
                    isRetryableCodexStreamError(error) &&
                    (useSse || !isCodexWebSocketUnavailableError(error)) &&
                    reportedAttempt < this.inferenceMaxRetries
                ) {
                    transportRetries += 1;
                    reportedAttempt += 1;
                    yield {
                        type: "retrying",
                        attempt: reportedAttempt,
                        reason: isEmptyResponseError(error)
                            ? error.message
                            : `Stream disconnected; reconnecting: ${displayMessage}`,
                    };
                    try {
                        if (isEmptyResponseError(error)) {
                            await this.#emptyResponseRetryWait(transportRetries, signal);
                        } else {
                            await waitForCodexRetry(transportRetries, error, signal);
                        }
                    } catch (delayError) {
                        if (signal?.aborted) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        throw delayError;
                    }
                    continue;
                }
                if (
                    this.transport === "auto" &&
                    !useSse &&
                    reportedAttempt < this.inferenceMaxRetries &&
                    (isRetryableCodexStreamError(error) || isCodexWebSocketUnavailableError(error))
                ) {
                    this.forceSse = true;
                    useSse = true;
                    transportRetries = 0;
                    reportedAttempt += 1;
                    yield {
                        type: "retrying",
                        attempt: reportedAttempt,
                        reason: `WebSocket retries exhausted; falling back to SSE: ${displayMessage}`,
                    };
                    if (signal?.aborted) {
                        yield { type: "done", state: "cancelled" };
                        return;
                    }
                    continue;
                }
                yield isEmptyResponseError(error)
                    ? emptyResponseDoneEvent(error, reportedAttempt + 1)
                    : {
                          type: "done",
                          state: "error",
                          kind: classifyCodexError(message),
                          message: displayMessage,
                          providerError: classifyCodexProviderError(
                              error,
                              message,
                              reportedAttempt + 1,
                          ),
                      };
                return;
            }
        }
    }

    private beginTurn(turnKey: string): void {
        this.turnId = randomUUID();
        this.turnKey = turnKey;
        this.turnState.clear();
    }

    private createRequest(
        context: SessionContext,
        configuration: SessionModelConfiguration,
        model: string,
        effort: SessionReasoningEffort,
        serviceTier?: CodexServiceTier,
        structuredOutput?: SessionRunRequest["structuredOutput"],
    ): CodexResponseRequest {
        return createCodexCliRequest({
            clientMetadata: createCodexClientMetadata({
                installationId: this.installationId,
                requestKind: "turn",
                sessionId: this.id,
                turnId: this.turnId,
                windowId: this.windowId,
            }),
            context,
            effort,
            model,
            ...(this.parallelToolCalls === undefined
                ? {}
                : { parallelToolCalls: this.parallelToolCalls }),
            promptCacheKey: this.id,
            ...(serviceTier === undefined ? {} : { serviceTier }),
            ...(structuredOutput === undefined ? {} : { structuredOutput }),
            tools: configuration.tools ?? [],
        });
    }

    private resolveClient(): OpenAI {
        return (this.client ??= createCodexClient({
            credential: this.credential,
            endpoint: this.endpoint,
            installationId: this.installationId,
            region: this.region,
            sessionId: this.id,
            userAgent: this.userAgent,
            windowId: this.windowId,
        }));
    }

    private replaceCredential(credential: CodexProviderCredential): void {
        this.credential = credential;
        this.client = undefined;
        this.websocketConnection.discard("credentials changed");
    }

    private websocketHeaders(): Record<string, string> {
        if (isBedrockCredential(this.credential)) {
            throw new Error("Amazon Bedrock does not support the Codex WebSocket transport.");
        }
        const token =
            this.credential.name === "codex-session"
                ? this.credential.credential.accessToken
                : this.credential.credential.apiKey;
        const accountId =
            this.credential.name === "codex-session"
                ? this.credential.credential.accountId
                : undefined;
        return {
            Authorization: `Bearer ${token}`,
            ...(accountId === undefined ? {} : { "chatgpt-account-id": accountId }),
            originator: "codex_exec",
            "OpenAI-Beta": "responses_websockets=2026-02-06",
            "session-id": this.id,
            "thread-id": this.id,
            "x-client-request-id": this.id,
            "x-codex-beta-features": "remote_compaction_v2",
            "x-codex-installation-id": this.installationId,
            "x-codex-window-id": this.windowId,
        };
    }

    private resolveConfiguration(model: string): SessionModelConfiguration {
        const explicit = this.modelConfigurations.get(model);
        if (explicit !== undefined) return explicit;
        if (this.activeModel === undefined) {
            this.modelConfigurations.set(model, this.activeConfiguration);
            return this.activeConfiguration;
        }
        if (codexModelsShareConfiguration(this.activeModel, model)) {
            this.modelConfigurations.set(model, this.activeConfiguration);
            return this.activeConfiguration;
        }
        throw new Error(
            `Codex model '${model}' requires a model configuration supplied when the session is created.`,
        );
    }
}

/** Bedrock's OpenAI transport has no documented native tool-search support. */
function codexTurnTools(tools: readonly SessionTool[], bedrock: boolean): readonly SessionTool[] {
    return bedrock ? tools.filter((tool) => !isCodexToolSearchDefinition(tool)) : tools;
}

function cloneConfiguration(configuration: SessionModelConfiguration): SessionModelConfiguration {
    return {
        instructions: configuration.instructions,
        tools: [...(configuration.tools ?? [])],
    };
}

/** Whether the complete caller-owned request can repair a poisoned incremental response chain. */
function codexRequestHasToolOutput(request: CodexResponseRequest, callId: string): boolean {
    return (
        Array.isArray(request.input) &&
        request.input.some(
            (item) =>
                (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
                item.call_id === callId,
        )
    );
}

function cancelledStream(): SessionStream {
    async function* stream(): AsyncGenerator<SessionEvent> {
        yield { type: "done", state: "cancelled" };
    }
    return stream();
}
