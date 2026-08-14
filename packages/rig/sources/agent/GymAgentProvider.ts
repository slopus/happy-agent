import { setTimeout as delay } from "node:timers/promises";

import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { GymInferenceRequest, GymInferenceResponse } from "../executor/gym-types.js";

export interface GymAgentProviderOptions {
    endpoint: string;
    fetch?: typeof globalThis.fetch;
    token?: string;
}

/**
 * Agent Base provider used only by the real PTY Gym.
 *
 * The control server deliberately keeps the established Gym request/response format so existing
 * terminal fixtures can exercise the new core without retaining the old Executor runtime.
 */
export class GymAgentProvider extends BaseProvider {
    static override readonly name = "gym";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly #options: GymAgentProviderOptions;

    constructor(options: GymAgentProviderOptions) {
        super();
        this.#options = options;
    }

    override async session(id: string, options: SessionOptions): Promise<BaseSession> {
        return new GymAgentSession(id, options, this.#options);
    }
}

class GymAgentSession extends BaseSession {
    readonly #endpoint: string;
    readonly #fetch: typeof globalThis.fetch;
    readonly #token: string | undefined;

    constructor(id: string, _sessionOptions: SessionOptions, options: GymAgentProviderOptions) {
        super(id);
        this.#endpoint = options.endpoint;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#token = options.token;
    }

    override run(ctx: Context, request: SessionRunRequest): SessionStream {
        return this.#run(ctx, request);
    }

    async *#run(ctx: Context, request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        const response = await this.#fetch(this.#endpoint, {
            body: JSON.stringify({
                context: {
                    messages: request.context.messages,
                    systemPrompt: request.context.instructions,
                } as unknown as GymInferenceRequest["context"],
                modelId: request.model ?? "openai/gym",
                options: {
                    ...(request.effort === undefined ? {} : { thinking: request.effort }),
                    ...(request.serviceTier === "priority" ? { serviceTier: "fast" as const } : {}),
                    sessionId: this.id,
                },
                providerId: "gym",
                providerSessionGeneration: 0,
            } satisfies GymInferenceRequest),
            headers: {
                "content-type": "application/json",
                ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }),
            },
            method: "POST",
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
        });
        if (!response.ok) {
            const detail = (await response.text()).trim();
            yield {
                kind: "internal_error",
                message:
                    detail.length === 0
                        ? `Gym inference failed with HTTP ${String(response.status)}.`
                        : `Gym inference failed with HTTP ${String(response.status)}: ${detail}`,
                state: "error",
                type: "done",
            };
            return;
        }

        const reply = (await response.json()) as GymInferenceResponse;
        if (reply.delayMs !== undefined) await wait(reply.delayMs, ctx);
        for (const retry of reply.providerRetries ?? []) {
            yield { attempt: retry.attempt, reason: retry.reason, type: "retrying" };
            if (retry.delayMs !== undefined) await wait(retry.delayMs, ctx);
        }

        for (const block of reply.content) {
            if (block.type === "text") {
                yield { type: "text_start" };
                for (const delta of chunks(block.text, reply.textDeltaChunkSize)) {
                    yield { delta, type: "text_delta" };
                    if (reply.textDeltaDelayMs !== undefined) {
                        await wait(reply.textDeltaDelayMs, ctx);
                    }
                }
                yield { type: "text_end" };
                continue;
            }
            if (block.type === "thinking") {
                yield { type: "reasoning_start" };
                for (const delta of chunks(block.thinking, reply.thinkingDeltaChunkSize)) {
                    yield { delta, type: "reasoning_delta" };
                    if (reply.thinkingDeltaDelayMs !== undefined) {
                        await wait(reply.thinkingDeltaDelayMs, ctx);
                    }
                }
                yield {
                    ...(block.encrypted === undefined ? {} : { reasoning: block.encrypted }),
                    type: "reasoning_end",
                };
                continue;
            }
            yield {
                callId: block.providerToolCallId ?? block.id,
                name: block.name,
                ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
                ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
                type: "toolcall_start",
            };
            const argumentsText = JSON.stringify(block.arguments);
            if (argumentsText.length > 0) {
                yield {
                    callId: block.providerToolCallId ?? block.id,
                    delta: argumentsText,
                    type: "toolcall_delta",
                };
            }
            yield {
                arguments: argumentsText,
                callId: block.providerToolCallId ?? block.id,
                ...(block.incomplete === true ? { incomplete: true } : {}),
                type: "toolcall_end",
            };
        }

        if (reply.completionDelayMs !== undefined) await wait(reply.completionDelayMs, ctx);
        const usage = reply.usage;
        if (usage !== undefined) {
            yield {
                type: "token_usage",
                usage: {
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    input: usage.input,
                    output: usage.output,
                    totalTokens: usage.totalTokens,
                },
            };
        }
        const stopReason =
            reply.stopReason ??
            (reply.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
        if (stopReason === "error") {
            yield {
                kind: "internal_error",
                message: reply.errorMessage ?? "Gym inference failed.",
                ...(reply.providerError === undefined
                    ? {}
                    : { providerError: reply.providerError }),
                state: "error",
                type: "done",
            };
        } else if (stopReason === "aborted") {
            yield { state: "cancelled", type: "done" };
        } else {
            yield {
                state:
                    stopReason === "toolUse"
                        ? "tool_call"
                        : stopReason === "length"
                          ? "length"
                          : "normal",
                tokens: {
                    input: usage?.input ?? 0,
                    output: usage?.output ?? 0,
                },
                type: "done",
            };
        }
    }

    override async compact(
        _ctx: Context,
        _options: SessionCompactionOptions,
    ): Promise<SessionCompaction> {
        return {
            kind: "inference_error",
            message: "Gym compaction is not connected to Agent Base.",
            status: "failed",
        };
    }

    override destroy(): void {}
}

function chunks(text: string, requestedSize: number | undefined): readonly string[] {
    if (text.length === 0) return [""];
    const size = Math.max(1, Math.floor(requestedSize ?? text.length));
    const output: string[] = [];
    for (let offset = 0; offset < text.length; offset += size) {
        output.push(text.slice(offset, offset + size));
    }
    return output;
}

async function wait(milliseconds: number, ctx: Context): Promise<void> {
    if (milliseconds <= 0) return;
    await delay(milliseconds, undefined, {
        ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
    });
}
