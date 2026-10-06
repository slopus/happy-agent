import { APIConnectionError, APIError } from "openai";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { BaseSession } from "@/core/BaseSession.js";
import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import { EMPTY_SESSION_USAGE } from "@/core/SessionUsage.js";
import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import { EmptyResponseError } from "@/core/EmptyResponseError.js";
import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import { ChatCompletionsConnection } from "./ChatCompletionsConnection.js";
import { createChatCompletionsRequest } from "./createChatCompletionsRequest.js";
import { mapChatCompletionsStream } from "./mapChatCompletionsStream.js";

export interface ChatCompletionsSessionOptions extends SessionOptions, InferenceRetryOptions {
    connection: ChatCompletionsConnection;
    model: string;
    resolveModel: (model: string) => string;
    generation: (request: SessionRunRequest) => Readonly<Record<string, unknown>>;
    compactionInstructions: string;
    createCompactedContext: (
        context: SessionContext,
        summary: string,
    ) => { context: SessionContext; preservedMessages: readonly SessionMessage[] };
}

export class ChatCompletionsSession extends BaseSession {
    private readonly options: ChatCompletionsSessionOptions;
    private readonly retries: () => number;
    private activeModel: string;
    private destroyed = false;
    private readonly shutdown = new AbortController();

    constructor(id: string, options: ChatCompletionsSessionOptions) {
        super(id);
        this.options = options;
        this.retries = createInferenceMaxRetriesResolver(options);
        this.activeModel = options.model;
    }

    async *run(ctx: Context, request: SessionRunRequest): SessionStream {
        if (ctx.lifetime?.aborted) {
            yield { type: "done", state: "cancelled" };
            return;
        }
        const signal =
            ctx.lifetime === undefined
                ? this.shutdown.signal
                : AbortSignal.any([ctx.lifetime, this.shutdown.signal]);
        if (this.destroyed) {
            yield {
                type: "done",
                state: "error",
                kind: "unknown",
                message: "This Bedrock session is closed.",
            };
            return;
        }
        const selectedModel = request.model ?? this.activeModel;
        const configuration = this.options.modelConfigurations?.[selectedModel];
        const tools = configuration?.tools ?? this.options.tools ?? [];
        let body: object;
        try {
            if (request.serviceTier !== undefined)
                throw new Error("These Bedrock models do not support inference speed tiers.");
            body = createChatCompletionsRequest({
                context:
                    configuration === undefined
                        ? request.context
                        : { ...request.context, instructions: configuration.instructions },
                model: this.options.resolveModel(selectedModel),
                tools,
                request,
                generation: this.options.generation(request),
            });
        } catch (error) {
            yield errorDone(error, 1);
            return;
        }
        this.activeModel = selectedModel;
        for (let attempt = 0; ; attempt++) {
            yield { type: "block_start" };
            try {
                let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
                for await (const event of mapChatCompletionsStream(
                    this.options.connection.run(body, signal),
                    tools,
                )) {
                    if (event.type === "done") terminal = event;
                    else yield event;
                }
                if (signal.aborted) throw new DOMException("Request was aborted", "AbortError");
                yield { type: "block_stop" };
                if (terminal !== undefined) yield terminal;
                return;
            } catch (error) {
                yield { type: "block_reset" };
                if (signal.aborted) {
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                if (attempt >= this.retries() || !retryable(error)) {
                    yield errorDone(error, attempt + 1);
                    return;
                }
                yield {
                    type: "retrying",
                    attempt: attempt + 1,
                    reason: "Retrying the Bedrock inference request.",
                };
                try {
                    await (this.options.waitForInferenceRetry ?? waitForInferenceRetry)(
                        attempt + 1,
                        signal,
                    );
                } catch (error) {
                    yield signal.aborted
                        ? { type: "done", state: "cancelled" }
                        : errorDone(error, attempt + 1);
                    return;
                }
            }
        }
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const signal =
            ctx.lifetime === undefined
                ? this.shutdown.signal
                : AbortSignal.any([ctx.lifetime, this.shutdown.signal]);
        if (signal.aborted) return { status: "cancelled", context: options.context };
        const custom = options.instructions?.trim()
            ? `\nOptional user instruction:\n${options.instructions.trim()}\n`
            : "";
        const instructions = this.options.compactionInstructions.includes(
            "${custom_instruction_block}",
        )
            ? this.options.compactionInstructions
                  .replace("${custom_instruction_block}", custom)
                  .trimEnd()
            : `${this.options.compactionInstructions}${custom}`;
        const context = {
            instructions: options.context.instructions,
            messages: [
                ...options.context.messages,
                { role: "user" as const, content: [{ type: "text" as const, text: instructions }] },
            ],
        };
        const assistant = new SessionAssistantMessageAccumulator();
        let usage = EMPTY_SESSION_USAGE;
        let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
        // Native compaction makes a summary inference with no tools, retaining the original prompt.
        const { modelConfigurations: _modelConfigurations, ...compactionOptions } = this.options;
        const compactor = new ChatCompletionsSession(this.id, {
            ...compactionOptions,
            instructions: context.instructions,
            model: options.model ?? this.activeModel,
            tools: [],
        });
        try {
            for await (const event of compactor.run(withLifetime(ctx, signal), {
                context,
                model: options.model ?? this.activeModel,
            })) {
                assistant.add(event);
                if (event.type === "block_reset") usage = EMPTY_SESSION_USAGE;
                if (event.type === "token_usage") usage = event.usage;
                if (event.type === "done") terminal = event;
            }
        } finally {
            compactor.destroy();
        }
        if (terminal?.state === "cancelled")
            return { status: "cancelled", context: options.context };
        if (terminal?.state !== "normal")
            return {
                status: "failed",
                kind: terminal?.state === "tool_call" ? "tool_call" : "inference_error",
                message:
                    terminal?.state === "error"
                        ? terminal.message
                        : "Bedrock did not complete the conversation summary.",
            };
        const summary = assistant
            .message()
            ?.content.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        if (!summary?.trim())
            return {
                status: "failed",
                kind: "invalid_summary",
                message: "Bedrock returned an empty conversation summary.",
            };
        const replacement = this.options.createCompactedContext(options.context, summary);
        return {
            status: "completed",
            summary,
            usage,
            ...replacement,
        };
    }

    destroy(): void {
        this.destroyed = true;
        this.shutdown.abort();
    }
}

function retryable(error: unknown): boolean {
    if (error instanceof APIConnectionError || error instanceof EmptyResponseError) return true;
    if (error instanceof APIError)
        return (
            error.status === 408 ||
            error.status === 409 ||
            error.status === 429 ||
            (error.status !== undefined && error.status >= 500)
        );
    return (
        error instanceof Error &&
        error.message === "Bedrock closed the chat stream before reporting completion."
    );
}

function errorDone(
    error: unknown,
    attempts: number,
): Extract<SessionEvent, { type: "done"; state: "error" }> {
    const diagnostics = extractProviderErrorDiagnostics(error, { attempts });
    const status = error instanceof APIError ? error.status : undefined;
    const message =
        error instanceof Error ? error.message : "The Bedrock inference request failed.";
    const contextOverflow =
        /context[_ ](?:window|length|limit)|too many (?:input )?tokens|input is too long/iu.test(
            message,
        );
    const type =
        status === 401 || status === 403
            ? "authentication"
            : status === 429
              ? "rate_limit"
              : status === 402
                ? "out_of_tokens"
                : status === 503 || status === 529
                  ? "server_overloaded"
                  : status !== undefined && status >= 500
                    ? "internal_server_error"
                    : error instanceof EmptyResponseError
                      ? "empty_response"
                      : "unclassified";
    const resetAt = extractProviderRetryResetAt(error);
    return {
        type: "done",
        state: "error",
        kind: contextOverflow
            ? "context_overflow"
            : status === 402
              ? "billing_error"
              : status !== undefined && status >= 500
                ? "internal_error"
                : "unknown",
        message:
            type === "authentication"
                ? "Authentication with Amazon Bedrock failed."
                : type === "rate_limit"
                  ? "The Amazon Bedrock rate limit was reached."
                  : type === "server_overloaded"
                    ? "Amazon Bedrock is temporarily overloaded."
                    : message,
        providerError: {
            type,
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ...((type === "rate_limit" || type === "out_of_tokens") && resetAt !== undefined
                ? { resetAt }
                : {}),
        },
    };
}
