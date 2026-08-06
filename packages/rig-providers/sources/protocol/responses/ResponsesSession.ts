import OpenAI from "openai";

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
import type { SessionContext, SessionMessage, SessionUserMessage } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import {
    MINIMAL_RESPONSES_CAPABILITIES,
    type ResponsesCapabilities,
} from "@/protocol/responses/ResponsesCapabilities.js";
import { createOpenAIResponseRequest } from "@/protocol/responses/createOpenAIResponseRequest.js";
import { classifyResponsesError } from "@/protocol/responses/classifyResponsesError.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { toSessionCacheUsage } from "@/protocol/responses/toSessionCacheUsage.js";

export interface ResponsesSessionOptions extends SessionOptions, InferenceRetryOptions {
    apiKey: string;
    endpoint: string;
    headers?: Readonly<Record<string, string>>;
    fetch?: typeof fetch;
    model?: string;
    nativeCompaction?: boolean;
    capabilities?: ResponsesCapabilities;
}

export class ResponsesSession extends BaseSession {
    private readonly client: OpenAI;
    private context: SessionContext;
    private readonly model: string | undefined;
    private activeModel: string | undefined;
    private readonly nativeCompaction: boolean;
    private readonly tools: readonly SessionTool[];
    private readonly capabilities: ResponsesCapabilities;
    private readonly resolveInferenceMaxRetries: () => number;
    private readonly retryWait: NonNullable<InferenceRetryOptions["waitForInferenceRetry"]>;

    constructor(id: string, options: ResponsesSessionOptions) {
        super(id);
        this.client = new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.endpoint,
            defaultHeaders: options.headers,
            fetch: options.fetch,
            maxRetries: 0,
        });
        this.context = { instructions: options.instructions, messages: [] };
        this.model = options.model;
        this.activeModel = options.model;
        this.nativeCompaction = options.nativeCompaction ?? true;
        this.tools = options.tools ?? [];
        this.capabilities = options.capabilities ?? MINIMAL_RESPONSES_CAPABILITIES;
        this.resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.retryWait = options.waitForInferenceRetry ?? waitForInferenceRetry;
    }

    run(request: SessionRunRequest): SessionStream {
        if (request.abort?.aborted) {
            // A pre-aborted generic protocol run never starts. The outer agent loop owns
            // cancellation presentation, so there is intentionally no synthetic terminal event.
            return emptySessionStream();
        }

        return this.streamRun(request);
    }

    async compact(options: SessionCompactionOptions = {}): Promise<SessionCompaction> {
        const { signal } = options;
        const context = this.context;
        if (signal?.aborted) {
            return { status: "cancelled", context };
        }

        if (!this.nativeCompaction) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "This Responses API endpoint does not provide native compaction.",
                context,
            };
        }
        const model = options.model ?? this.activeModel ?? this.model;
        if (model === undefined) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "A model is required for Responses API compaction.",
                context,
            };
        }
        this.activeModel = model;
        const compactedContext =
            options.context === undefined
                ? context
                : {
                      instructions: context.instructions,
                      messages: [...options.context.messages],
                  };
        try {
            const response = await this.client.responses.compact(
                {
                    model,
                    input: toOpenAIResponseInput(compactedContext),
                    instructions: compactedContext.instructions,
                },
                signal === undefined ? undefined : { signal },
            );
            if (signal?.aborted) return { status: "cancelled", context };
            const item = response.output.find((output) => output.type === "compaction");
            if (item === undefined) {
                return {
                    status: "failed",
                    kind: "invalid_summary",
                    message: "Responses API compaction returned no compaction item.",
                    context,
                };
            }
            const compaction = {
                role: "compaction" as const,
                content: null,
                encryptedContent: item.encrypted_content,
                vendor: { type: "responses_compaction", id: item.id },
            };
            const preservedMessages = preservedResponsesMessages(
                response.output,
                compactedContext.messages,
            );
            this.context = {
                instructions: compactedContext.instructions,
                messages: [...preservedMessages, compaction],
            };
            return {
                status: "completed",
                compaction,
                preservedMessages,
                usage: toSessionCacheUsage(response.usage),
                context: this.context,
            };
        } catch (error) {
            if (signal?.aborted) return { status: "cancelled", context };
            return {
                status: "failed",
                kind: "inference_error",
                message:
                    error instanceof Error ? error.message : "Responses API compaction failed.",
                context,
            };
        }
    }

    destroy(): void {}

    private async *streamRun(request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        const { abort } = request;
        this.context = {
            instructions: this.context.instructions,
            messages: [...request.context.messages],
        };
        const context = this.context;

        if (abort?.aborted) {
            return;
        }

        const model = request.model ?? this.model;
        if (model === undefined) {
            yield {
                type: "done",
                state: "error",
                kind: "unknown",
                message: "A model is required for Responses API inference.",
            };
            return;
        }
        this.activeModel = model;

        let emptyResponseRetries = 0;
        for (;;) {
            const attemptUsage: Extract<SessionEvent, { type: "token_usage" }>[] = [];
            yield { type: "block_start" };
            try {
                const responseStream = await this.client.responses.create(
                    createOpenAIResponseRequest({
                        context,
                        model,
                        ...(request.structuredOutput === undefined
                            ? {}
                            : { structuredOutput: request.structuredOutput }),
                        tools: this.tools,
                        capabilities: this.capabilities,
                        ...(request.effort === undefined ? {} : { effort: request.effort }),
                    }),
                    abort === undefined ? undefined : { signal: abort },
                );
                const inference = mapOpenAIResponseStream(responseStream, {
                    failureMessage: `${model} failed to generate a response.`,
                    requireTerminalEvent: true,
                    vendor: "responses",
                    ...(abort === undefined ? {} : { signal: abort }),
                });
                let result;
                let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
                for (;;) {
                    const next = await inference.next();
                    if (next.done) {
                        result = next.value;
                        break;
                    }
                    if (next.value.type === "done") {
                        terminal = next.value;
                    } else if (next.value.type === "token_usage") {
                        attemptUsage.push(next.value);
                    } else {
                        yield next.value;
                    }
                }
                if (result.outputTokensReported && result.usage.output === 0) {
                    throw new EmptyResponseError("Responses API");
                }
                for (const event of attemptUsage) yield event;
                if (
                    result.assistantText.length > 0 ||
                    result.encryptedReasoning !== undefined ||
                    result.toolCalls.length > 0 ||
                    result.responseItems.length > 0
                ) {
                    this.context = {
                        instructions: this.context.instructions,
                        messages: [
                            ...this.context.messages,
                            {
                                role: "assistant",
                                content: result.assistantText,
                                ...(result.encryptedReasoning === undefined
                                    ? {}
                                    : { encryptedReasoning: result.encryptedReasoning }),
                                ...(result.toolCalls.length === 0
                                    ? {}
                                    : { toolCalls: result.toolCalls }),
                                ...(result.responseItems.length === 0
                                    ? {}
                                    : { responseItems: result.responseItems }),
                            },
                        ],
                    };
                }
                if (result.responseItems.length > 0) {
                    yield { type: "response_items", items: result.responseItems };
                }
                yield { type: "block_stop" };
                if (terminal !== undefined) yield terminal;
                return;
            } catch (error) {
                yield { type: "block_reset" };
                for (const event of attemptUsage) yield event;
                if (abort?.aborted) {
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                if (
                    isEmptyResponseError(error) &&
                    emptyResponseRetries < this.resolveInferenceMaxRetries()
                ) {
                    emptyResponseRetries += 1;
                    yield {
                        type: "retrying",
                        attempt: emptyResponseRetries,
                        reason: error.message,
                    };
                    try {
                        await this.retryWait(emptyResponseRetries, abort);
                    } catch (delayError) {
                        if (abort?.aborted) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        throw delayError;
                    }
                    continue;
                }
                yield isEmptyResponseError(error)
                    ? emptyResponseDoneEvent(error, emptyResponseRetries + 1)
                    : classifyResponsesError(error);
                return;
            }
        }
    }
}

function emptySessionStream(): SessionStream {
    async function* generator(): AsyncGenerator<SessionEvent> {}
    return generator();
}

function preservedResponsesMessages(
    output: readonly unknown[],
    source: readonly SessionMessage[],
): SessionUserMessage[] {
    const candidates = source.filter(
        (message): message is SessionUserMessage => message.role === "user",
    );
    const preserved: SessionUserMessage[] = [];
    let candidateIndex = 0;
    for (const item of output) {
        const text = compactedUserText(item);
        if (text === undefined) continue;
        const matchIndex = candidates.findIndex(
            (candidate, index) => index >= candidateIndex && sessionUserText(candidate) === text,
        );
        if (matchIndex < 0) {
            preserved.push({ role: "user", content: text });
            continue;
        }
        preserved.push(structuredClone(candidates[matchIndex]!));
        candidateIndex = matchIndex + 1;
    }
    return preserved;
}

function compactedUserText(item: unknown): string | undefined {
    if (
        typeof item !== "object" ||
        item === null ||
        !("type" in item) ||
        item.type !== "message" ||
        !("role" in item) ||
        item.role !== "user" ||
        !("content" in item)
    ) {
        return undefined;
    }
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return undefined;
    return item.content
        .flatMap((part) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "input_text" &&
            "text" in part &&
            typeof part.text === "string"
                ? [part.text]
                : [],
        )
        .join("");
}

function sessionUserText(message: SessionUserMessage): string {
    if (message.input === undefined) return message.content;
    return message.input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}
