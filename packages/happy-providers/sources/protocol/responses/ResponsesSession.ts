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
import { responsesServerToolName } from "@/protocol/responses/toResponsesToolDefinitions.js";
import { toSessionUsage } from "@/protocol/responses/toSessionUsage.js";
import type { Context } from "@steve.kite/stdlib";

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

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        if (ctx.lifetime?.aborted) {
            // A pre-aborted generic protocol run never starts. The outer agent loop owns
            // cancellation presentation, so there is intentionally no synthetic terminal event.
            return emptySessionStream();
        }

        return this.streamRun(ctx, request);
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const signal = ctx.lifetime;
        const context: SessionContext = {
            instructions: options.context.instructions,
            messages: [...options.context.messages],
        };
        if (signal?.aborted) {
            return { status: "cancelled", context };
        }

        if (!this.nativeCompaction) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "This Responses API endpoint does not provide native compaction.",
            };
        }
        const model = options.model ?? this.activeModel ?? this.model;
        if (model === undefined) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "A model is required for Responses API compaction.",
            };
        }
        this.activeModel = model;
        const compactedContext = context;
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
                usage: toSessionUsage(response.usage),
                context: this.context,
            };
        } catch (error) {
            if (signal?.aborted) return { status: "cancelled", context };
            return {
                status: "failed",
                kind: "inference_error",
                message:
                    error instanceof Error ? error.message : "Responses API compaction failed.",
            };
        }
    }

    destroy(): void {}

    private async *streamRun(
        ctx: Context,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        const abort = ctx.lifetime;
        this.context = {
            instructions: request.context.instructions ?? this.context.instructions,
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
                    serverToolNames: new Set(
                        this.tools.flatMap((tool) => {
                            const name = responsesServerToolName(tool);
                            return name === undefined ? [] : [name];
                        }),
                    ),
                    serverToolDisplayNames: new Map(
                        this.tools.flatMap((tool) => {
                            const name = responsesServerToolName(tool);
                            return name === undefined ? [] : [[name, tool.name] as const];
                        }),
                    ),
                    serverToolDisplayNamespaces: new Map(
                        this.tools.flatMap((tool) => {
                            const name = responsesServerToolName(tool);
                            return name === undefined || tool.namespace === undefined
                                ? []
                                : [[name, tool.namespace] as const];
                        }),
                    ),
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
                if (result.message.content.length > 0) {
                    this.context = {
                        instructions: this.context.instructions,
                        messages: [...this.context.messages, result.message],
                    };
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
            preserved.push({ role: "user", content: [{ type: "text", text }] });
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
    return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}
