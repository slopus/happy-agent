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
import type { AnthropicBedrockClient as CreatedAnthropicBedrockClient } from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";
import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";
import { requestAnthropicBedrockCompaction } from "@/vendors/bedrock/impl/requestAnthropicBedrockCompaction.js";
import { resolveAnthropicBedrockModelId } from "@/vendors/bedrock/impl/resolveAnthropicBedrockModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import type { Context } from "@steve.kite/stdlib";

export type AnthropicBedrockClient = CreatedAnthropicBedrockClient;

export interface AnthropicBedrockSessionOptions extends InferenceRetryOptions {
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
    private readonly emptyResponseRetryWait: NonNullable<
        InferenceRetryOptions["waitForInferenceRetry"]
    >;

    constructor(id: string, options: AnthropicBedrockSessionOptions) {
        super(id);
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
            const native = await requestAnthropicBedrockCompaction({
                client: this.connection.client(),
                maxRetries: this.resolveInferenceMaxRetries(),
                request: this.createRequest({
                    compactionInstructions: options.instructions ?? null,
                    context: original,
                    model,
                    // Use the selected model's normal tools: replayed native tool-search results
                    // reference their definitions even when generation pauses after compaction.
                    ...(this.activeEffort === undefined ? {} : { effort: this.activeEffort }),
                }),
                ...(signal === undefined ? {} : { signal }),
            });
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
            const request = this.createRequest({ ...options, tools });
            let failedAttempts = 0;
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
                    })) {
                        if (event.type === "block_start") blockStarted = true;
                        if (isAnthropicResponseContentEvent(event)) {
                            responseContentStarted = true;
                        }
                        yield event;
                    }
                    return;
                } catch (error) {
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
        return createAnthropicRequest({
            context,
            model: resolveAnthropicBedrockModelId(options.model, this.region, this.transport),
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
