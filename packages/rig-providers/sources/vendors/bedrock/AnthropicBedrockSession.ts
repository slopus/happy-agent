import { BaseSession } from "@/core/BaseSession.js";
import { emptyResponseDoneEvent, isEmptyResponseError } from "@/core/EmptyResponseError.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext, SessionToolCall } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import {
    describeAnthropicBedrockRetry,
    resolveAnthropicBedrockRetryDelay,
    shouldRetryAnthropicBedrock,
    waitForAnthropicBedrockRetry,
} from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";
import {
    classifyAnthropicBedrockError,
    classifyAnthropicBedrockProviderError,
} from "@/vendors/bedrock/errors/anthropicBedrockErrors.js";
import { AnthropicBedrockConnection } from "@/vendors/bedrock/impl/AnthropicBedrockConnection.js";
import type { AnthropicBedrockClient as CreatedAnthropicBedrockClient } from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";
import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";
import { requestAnthropicBedrockCompaction } from "@/vendors/bedrock/impl/requestAnthropicBedrockCompaction.js";
import { resolveAnthropicBedrockModelId } from "@/vendors/bedrock/impl/resolveAnthropicBedrockModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";

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
            bearerToken: () => this.credential.credential.bearerToken,
            ...(options.client === undefined ? {} : { client: options.client }),
            ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
            region: this.region,
            transport: this.transport,
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
        this.context = { instructions: options.instructions, messages: [] };
    }

    run(request: SessionRunRequest): SessionStream {
        if (request.abort?.aborted) return emptyStream();
        return this.streamRun(request);
    }

    async compact(options: SessionCompactionOptions = {}): Promise<SessionCompaction> {
        const original =
            options.context === undefined
                ? this.context
                : {
                      instructions: this.context.instructions,
                      messages: [...options.context.messages],
                  };
        if (options.signal?.aborted) return { status: "cancelled", context: original };
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
                    tools: [],
                    ...(this.activeEffort === undefined ? {} : { effort: this.activeEffort }),
                }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            if (options.signal?.aborted) return { status: "cancelled", context: original };
            if (native.block === undefined) {
                return {
                    status: "failed",
                    kind: "inference_error",
                    message: "Anthropic Bedrock native compaction returned no compaction block.",
                    context: original,
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
            if (options.signal?.aborted) return { status: "cancelled", context: original };
            return {
                status: "failed",
                kind: "inference_error",
                message: error instanceof Error ? error.message : String(error),
                context: original,
            };
        }
    }

    destroy(): void {
        this.connection.close();
    }

    private async *streamRun(request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        const model = request.model ?? this.activeModel ?? this.model;
        if (model === undefined) {
            throw new Error("A model is required for Anthropic Bedrock inference.");
        }
        this.activeModel = model;
        const effort = request.effort ?? this.activeEffort;
        this.activeEffort = effort;
        this.context = {
            instructions: this.context.instructions,
            messages: [...request.context.messages],
        };
        let assistantText = "";
        let encryptedReasoning: string | undefined;
        let responseItems: readonly string[] | undefined;
        const toolCalls = new Map<string, SessionToolCall>();
        for await (const event of this.streamQuery({
            context: this.context,
            model,
            ...(effort === undefined ? {} : { effort }),
            ...(request.abort === undefined ? {} : { signal: request.abort }),
            ...(request.structuredOutput === undefined
                ? {}
                : { structuredOutput: request.structuredOutput }),
        })) {
            if (event.type === "text_delta") assistantText += event.delta;
            if (event.type === "encrypted_reasoning") encryptedReasoning = event.content;
            if (event.type === "response_items") responseItems = event.items;
            if (event.type === "toolcall_start") {
                toolCalls.set(event.callId, {
                    callId: event.callId,
                    name: event.name,
                    arguments: "",
                    vendor: event.vendor,
                });
            }
            if (event.type === "toolcall_delta") {
                const call = toolCalls.get(event.callId);
                if (call !== undefined) {
                    toolCalls.set(event.callId, {
                        ...call,
                        arguments: call.arguments + event.delta,
                    });
                }
            }
            if (event.type === "toolcall_end") {
                const call = toolCalls.get(event.callId);
                if (call !== undefined) {
                    toolCalls.set(event.callId, { ...call, arguments: event.arguments });
                }
            }
            if (event.type === "block_reset") {
                assistantText = "";
                encryptedReasoning = undefined;
                responseItems = undefined;
                toolCalls.clear();
            }
            if (event.type === "done" && event.state !== "error" && event.state !== "cancelled") {
                this.context = {
                    instructions: this.context.instructions,
                    messages: [
                        ...this.context.messages,
                        {
                            role: "assistant",
                            content: assistantText,
                            ...(encryptedReasoning === undefined ? {} : { encryptedReasoning }),
                            ...(responseItems === undefined ? {} : { responseItems }),
                            ...(toolCalls.size === 0 ? {} : { toolCalls: [...toolCalls.values()] }),
                        },
                    ],
                };
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
                try {
                    attempts += 1;
                    const response = await this.connection.stream(
                        request,
                        ...(options.signal === undefined ? [] : ([options.signal] as const)),
                    );
                    for await (const event of mapAnthropicStream(response, {
                        onOutputStarted: () => {
                            responseContentStarted = true;
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
                    if (responseContentStarted && !isEmptyResponseError(error)) throw error;
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
                      message: error instanceof Error ? error.message : String(error),
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
        event.type === "text_delta" ||
        event.type === "reasoning_delta" ||
        event.type === "toolcall_start" ||
        event.type === "toolcall_delta" ||
        event.type === "toolcall_end"
    );
}
