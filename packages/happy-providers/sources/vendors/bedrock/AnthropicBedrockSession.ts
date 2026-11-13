import {
    assertBedrockModelIds,
    mappedBedrockModelId,
} from "@/vendors/bedrock/impl/assertBedrockModelIds.js";
import { BaseSession } from "@/core/BaseSession.js";
import { emptyResponseDoneEvent, isEmptyResponseError } from "@/core/EmptyResponseError.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext } from "@/core/SessionContext.js";
import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import {
    describeAnthropicBedrockRetry,
    isAnthropicBedrockConnectionFailure,
    isRetryableAnthropicBedrockStreamError,
    resolveAnthropicBedrockRetryDelay,
    shouldRetryAnthropicBedrock,
    waitForAnthropicBedrockRetry,
} from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";
import {
    classifyAnthropicBedrockError,
    classifyAnthropicBedrockProviderError,
    describeAnthropicBedrockErrorMessage,
} from "@/vendors/bedrock/errors/anthropicBedrockErrors.js";
import { AnthropicBedrockConnection } from "@/vendors/bedrock/impl/AnthropicBedrockConnection.js";
import {
    carriesAnthropicThinkingBinding,
    dropsMismatchedAnthropicBedrockThinking,
    isAnthropicThinkingBindingRefusal,
} from "@/vendors/bedrock/impl/anthropicBedrockThinkingBinding.js";
import {
    anthropicThinkingMismatchPosition,
    anthropicThinkingToRemove,
    isAnthropicThinkingPrefixMismatch,
    withoutAnthropicThinking,
} from "@/vendors/bedrock/impl/anthropicBedrockThinkingHeal.js";
import type { AnthropicBedrockClient as CreatedAnthropicBedrockClient } from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";
import {
    createAnthropicRequest,
    type AnthropicRequest,
} from "@/protocol/anthropic/createAnthropicRequest.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";
import { pendingAnthropicServerTools } from "@/protocol/anthropic/anthropicServerToolContinuation.js";
import { requestAnthropicBedrockCompaction } from "@/vendors/bedrock/impl/requestAnthropicBedrockCompaction.js";
import { resolveAnthropicBedrockModelId } from "@/vendors/bedrock/impl/resolveAnthropicBedrockModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import type { Context } from "@steve.kite/stdlib";

export type AnthropicBedrockClient = CreatedAnthropicBedrockClient;

export interface AnthropicBedrockSessionOptions extends InferenceRetryOptions {
    /**
     * Wire model IDs keyed by the caller's model ID, such as an application-inference-profile ARN
     * for `anthropic/opus-5-5`. Only the request's `model` changes; tools, instructions, and every
     * other choice stay keyed by the caller's model ID.
     */
    bedrockModelIds?: Readonly<Record<string, string>>;
    client?: AnthropicBedrockClient;
    instructions: string;
    credential: BedrockCredential;
    endpoint?: string;
    model?: string;
    modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
    region: string;
    tools?: readonly SessionTool[];
    transport: AnthropicBedrockTransport;
    userAgent?: string;
}

export class AnthropicBedrockSession extends BaseSession {
    readonly bedrockModelIds: Readonly<Record<string, string>> | undefined;
    readonly credential: BedrockCredential;
    readonly endpoint: string | undefined;
    readonly model: string | undefined;
    readonly region: string;
    readonly tools: readonly SessionTool[] | undefined;
    readonly transport: AnthropicBedrockTransport;
    readonly userAgent: string | undefined;

    private activeEffort: SessionReasoningEffort | undefined;
    private activeModel: string | undefined;
    private readonly connection: AnthropicBedrockConnection;
    private context: SessionContext;
    private readonly modelConfigurations:
        | Readonly<Record<string, SessionModelConfiguration>>
        | undefined;
    private readonly resolveInferenceMaxRetries: () => number;
    /** Set once the endpoint refuses the thinking-binding control; it is not sent again. */
    private thinkingBindingRefused = false;
    /**
     * Thinking blocks the API rejected as bound to a different conversation, by identity. They
     * stay in the caller's history, so every later request of this session leaves them out again:
     * thinking produced since is bound to a history without them, and putting them back would
     * fail it too. An identity is forgotten once the history no longer holds its block.
     */
    private readonly removedThinking = new Set<string>();
    private readonly emptyResponseRetryWait: NonNullable<
        InferenceRetryOptions["waitForInferenceRetry"]
    >;

    constructor(id: string, options: AnthropicBedrockSessionOptions) {
        super(id);
        assertBedrockModelIds(options.bedrockModelIds);
        this.bedrockModelIds = options.bedrockModelIds;
        this.credential = options.credential;
        this.endpoint = options.endpoint;
        this.model = options.model;
        this.activeModel = options.model;
        this.region = options.region;
        this.tools = options.tools;
        this.transport = options.transport;
        this.userAgent = options.userAgent;
        this.modelConfigurations = options.modelConfigurations;
        this.resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.emptyResponseRetryWait = options.waitForInferenceRetry ?? waitForInferenceRetry;
        this.connection = new AnthropicBedrockConnection({
            ...(options.client === undefined ? {} : { client: options.client }),
            credential: this.credential,
            ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
            region: this.region,
            transport: this.transport,
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
        this.context = { instructions: options.instructions, messages: [] };
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
        const signal = ctx.lifetime;
        if (signal?.aborted) return { status: "cancelled", context: original };
        const model = options.model ?? this.activeModel ?? this.model;
        if (model === undefined) {
            throw new Error("A model is required for Anthropic Bedrock compaction.");
        }
        this.activeModel = model;
        try {
            const compact = async (request: AnthropicRequest) =>
                await requestAnthropicBedrockCompaction({
                    client: this.connection.client(),
                    maxRetries: this.resolveInferenceMaxRetries(),
                    request,
                    ...(signal === undefined ? {} : { signal }),
                });
            const createRequest = () =>
                this.createRequest({
                    compactionInstructions: options.instructions ?? null,
                    context: original,
                    model,
                    // Use the selected model's normal tools: replayed native tool-search results
                    // reference their definitions even when generation pauses after compaction.
                    ...(this.activeEffort === undefined ? {} : { effort: this.activeEffort }),
                });
            // The same bounded renegotiation as inference: the control is dropped at most once
            // for the session, and rejected thinking is removed in at most two steps.
            let request = createRequest();
            let healed = 0;
            let native: Awaited<ReturnType<typeof compact>>;
            while (true) {
                try {
                    native = await compact(request);
                    break;
                } catch (error) {
                    if (this.refusesThinkingBinding(request, error)) {
                        request = createRequest();
                        continue;
                    }
                    const without = this.withoutRejectedThinking(request, error, healed);
                    if (without === undefined) throw error;
                    healed += 1;
                    request = without;
                }
            }
            if (signal?.aborted) return { status: "cancelled", context: original };
            if (native.block === undefined) {
                return {
                    status: "failed",
                    kind: "inference_error",
                    message: "Anthropic Bedrock native compaction returned no compaction block.",
                };
            }
            const compaction = {
                role: "compaction" as const,
                content: native.block.content,
                encryptedContent: native.block.encrypted_content,
            };
            const preservedMessages = original.messages.filter(
                (message) => message.role === "system",
            );
            this.context = {
                instructions: original.instructions,
                messages: [...preservedMessages, compaction],
            };
            return {
                status: "completed",
                compaction,
                preservedMessages,
                usage: native.usage,
                context: this.context,
            };
        } catch (error) {
            if (signal?.aborted) return { status: "cancelled", context: original };
            return {
                status: "failed",
                kind: "inference_error",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    destroy(): void {
        this.connection.close();
    }

    private async *streamRun(
        ctx: Context,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        const signal = ctx.lifetime;
        const model = request.model ?? this.activeModel ?? this.model;
        if (model === undefined) {
            throw new Error("A model is required for Anthropic Bedrock inference.");
        }
        this.activeModel = model;
        const effort = request.effort ?? this.activeEffort;
        this.activeEffort = effort;
        this.context = {
            instructions: request.context.instructions ?? this.context.instructions,
            messages: [...request.context.messages],
        };
        const assistant = new SessionAssistantMessageAccumulator();
        for await (const event of this.streamQuery({
            context: this.context,
            model,
            ...(effort === undefined ? {} : { effort }),
            ...(signal === undefined ? {} : { signal }),
            ...(request.structuredOutput === undefined
                ? {}
                : { structuredOutput: request.structuredOutput }),
        })) {
            assistant.add(event);
            if (event.type === "done" && event.state !== "error" && event.state !== "cancelled") {
                const message = assistant.message();
                if (message !== undefined) {
                    this.context = {
                        instructions: this.context.instructions,
                        messages: [...this.context.messages, message],
                    };
                }
            }
            yield event;
        }
    }

    private async *streamQuery(options: {
        context: SessionContext;
        effort?: SessionReasoningEffort;
        model: string;
        signal?: AbortSignal;
        structuredOutput?: SessionRunRequest["structuredOutput"];
        tools?: readonly SessionTool[];
    }): AsyncGenerator<SessionEvent> {
        let blockStarted = false;
        let attempts = 0;
        try {
            const tools = this.resolveTools(options.model, options.tools);
            let request = this.createRequest({ ...options, tools });
            let failedAttempts = 0;
            let healed = 0;
            while (true) {
                let responseContentStarted = false;
                let compactionOutputStarted = false;
                try {
                    attempts += 1;
                    const response = await this.connection.stream(
                        request,
                        ...(options.signal === undefined ? [] : ([options.signal] as const)),
                    );
                    for await (const event of mapAnthropicStream(response, {
                        // mapAnthropicStream reports output through this callback only for
                        // compaction blocks; ordinary content is visible in the events below.
                        onOutputStarted: () => {
                            responseContentStarted = true;
                            compactionOutputStarted = true;
                        },
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                        tools,
                        pendingServerTools: pendingAnthropicServerTools(options.context.messages),
                    })) {
                        if (event.type === "block_start") blockStarted = true;
                        if (isAnthropicResponseContentEvent(event)) {
                            responseContentStarted = true;
                        }
                        yield event;
                    }
                    return;
                } catch (error) {
                    // An endpoint that does not take the thinking-binding control rejects the
                    // request before it runs. Ask again without it; that is not a failed attempt.
                    if (!responseContentStarted && this.refusesThinkingBinding(request, error)) {
                        request = this.createRequest({ ...options, tools });
                        continue;
                    }
                    // Replayed thinking whose prefix changed is rejected before anything runs,
                    // and the same request can never pass. Leave the rejected thinking out and
                    // ask again; that is not a failed attempt either.
                    const without = responseContentStarted
                        ? undefined
                        : this.withoutRejectedThinking(request, error, healed);
                    if (without !== undefined) {
                        healed += 1;
                        request = without;
                        continue;
                    }
                    // A connection that drops mid-response, or a retryable error event the
                    // server sent on the open stream, is replayed through the block_reset
                    // rollback below, unless compaction output began: compaction is stateful on
                    // the server and must not be replayed.
                    const replayableAfterContent =
                        !compactionOutputStarted &&
                        (isAnthropicBedrockConnectionFailure(error) ||
                            isRetryableAnthropicBedrockStreamError(error));
                    if (
                        responseContentStarted &&
                        !isEmptyResponseError(error) &&
                        !replayableAfterContent
                    ) {
                        throw error;
                    }
                    failedAttempts += 1;
                    if (blockStarted) {
                        yield { type: "block_reset" };
                        blockStarted = false;
                    }
                    if (isEmptyResponseError(error) && error.usage !== undefined) {
                        yield { type: "token_usage", usage: error.usage };
                    }
                    const maxRetries = this.resolveInferenceMaxRetries();
                    if (!shouldRetryAnthropicBedrock(error, failedAttempts, maxRetries))
                        throw error;
                    const delay = resolveAnthropicBedrockRetryDelay(error, failedAttempts);
                    yield {
                        type: "retrying",
                        attempt: failedAttempts,
                        reason: describeAnthropicBedrockRetry(
                            error,
                            failedAttempts,
                            delay,
                            maxRetries,
                        ),
                    };
                    if (isEmptyResponseError(error)) {
                        await this.emptyResponseRetryWait(failedAttempts, options.signal);
                    } else {
                        await waitForAnthropicBedrockRetry(delay, options.signal);
                    }
                }
            }
        } catch (error) {
            if (!blockStarted) yield { type: "block_start" };
            if (options.signal?.aborted) {
                yield { type: "block_reset" };
                yield { type: "done", state: "cancelled" };
                return;
            }
            yield { type: "block_reset" };
            yield isEmptyResponseError(error)
                ? emptyResponseDoneEvent(error, attempts)
                : {
                      type: "done",
                      state: "error",
                      kind: classifyAnthropicBedrockError(error),
                      message: describeAnthropicBedrockErrorMessage(error),
                      providerError: classifyAnthropicBedrockProviderError(error, attempts),
                  };
        }
    }

    private createRequest(options: {
        compactionInstructions?: string | null;
        context: SessionContext;
        effort?: SessionReasoningEffort;
        model: string;
        structuredOutput?: SessionRunRequest["structuredOutput"];
        tools?: readonly SessionTool[];
    }) {
        const modelConfiguration = this.modelConfigurations?.[options.model];
        const tools = this.resolveTools(options.model, options.tools);
        const context =
            modelConfiguration === undefined
                ? options.context
                : {
                      instructions: modelConfiguration.instructions,
                      messages: options.context.messages,
                  };
        const wireModel =
            mappedBedrockModelId(this.bedrockModelIds, options.model) ??
            resolveAnthropicBedrockModelId(options.model, this.region, this.transport);
        const request = createAnthropicRequest({
            context,
            dropMismatchedThinking:
                !this.thinkingBindingRefused &&
                dropsMismatchedAnthropicBedrockThinking({
                    model: options.model,
                    transport: this.transport,
                    wireModel,
                }),
            model: wireModel,
            ...(options.structuredOutput === undefined
                ? {}
                : { structuredOutput: options.structuredOutput }),
            tools,
            ...(options.compactionInstructions === undefined
                ? {}
                : {
                      compaction:
                          options.compactionInstructions === null
                              ? {}
                              : { instructions: options.compactionInstructions },
                  }),
            ...(options.effort === undefined ? {} : { effort: options.effort }),
        });
        if (this.removedThinking.size === 0) return request;
        // Compaction and rewinding take rejected thinking out of the history for good.
        const present = new Set(anthropicThinkingToRemove(request, undefined));
        for (const identity of this.removedThinking) {
            if (!present.has(identity)) this.removedThinking.delete(identity);
        }
        return withoutAnthropicThinking(request, this.removedThinking);
    }

    /**
     * The request to send instead after the API rejected replayed thinking as bound to a
     * different conversation, or `undefined` when the rejection is something else or nothing is
     * left to remove.
     *
     * The first rejection of a request removes the block the API named and all thinking after
     * it, which is the API's documented repair; when it names none, or the name does not land on
     * a thinking block, all thinking goes. A second rejection removes whatever thinking is left.
     * There is no third step, so one request costs at most two extra round trips. What was
     * removed is remembered for the session, so later requests do not send it and fail again.
     */
    private withoutRejectedThinking(
        request: AnthropicRequest,
        error: unknown,
        healed: number,
    ): AnthropicRequest | undefined {
        if (healed >= 2 || !isAnthropicThinkingPrefixMismatch(error)) return undefined;
        const rejected = anthropicThinkingToRemove(
            request,
            healed === 0 ? anthropicThinkingMismatchPosition(error) : undefined,
        );
        if (rejected.length === 0) return undefined;
        for (const identity of rejected) this.removedThinking.add(identity);
        return withoutAnthropicThinking(request, this.removedThinking);
    }

    /**
     * Whether this failure is the endpoint refusing the thinking-binding control the request
     * carried. Remembers a refusal, so the session's later requests leave the control out.
     */
    private refusesThinkingBinding(request: AnthropicRequest, error: unknown): boolean {
        if (this.thinkingBindingRefused) return false;
        if (!carriesAnthropicThinkingBinding(request)) return false;
        if (!isAnthropicThinkingBindingRefusal(error)) return false;
        this.thinkingBindingRefused = true;
        return true;
    }

    private resolveTools(
        model: string,
        tools: readonly SessionTool[] | undefined,
    ): readonly SessionTool[] {
        return (
            tools ??
            this.modelConfigurations?.[model]?.tools ??
            this.tools ??
            resolveClaudeTools(model)
        );
    }
}

function emptyStream(): SessionStream {
    async function* stream(): AsyncGenerator<SessionEvent> {}
    return stream();
}

function isAnthropicResponseContentEvent(event: SessionEvent): boolean {
    return (
        event.type === "text_start" ||
        event.type === "text_delta" ||
        event.type === "reasoning_start" ||
        event.type === "reasoning_delta" ||
        event.type === "toolcall_start" ||
        event.type === "toolcall_delta" ||
        event.type === "toolcall_end" ||
        event.type === "toolcall_result_start" ||
        event.type === "toolcall_result_delta" ||
        event.type === "toolcall_result_end"
    );
}
