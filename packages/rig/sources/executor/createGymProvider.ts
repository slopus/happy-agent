import type { ProviderUsage } from "@slopus/rig-providers";
import { createInferenceStream } from "@slopus/rig-execution";
import type { GymInferenceRequest, GymInferenceResponse } from "./gym-types.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type HostedCapability,
    type Model,
    type Provider,
    type ProviderAssistantMessageEvent,
    type ServiceTier,
    type StreamOptions,
    type Usage,
} from "@slopus/rig-execution";

export const gymModel = defineModel({
    id: "openai/gym",
    name: "Gym",
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultThinkingLevel: "off",
    contextWindow: 272_000,
});

export interface CreateGymProviderOptions {
    contextWindow?: number;
    endpoint: string;
    extendProfilePromptContext?: Provider["extendProfilePromptContext"];
    fetch?: typeof globalThis.fetch;
    /** The real provider's answer, forwarded so a gym test reads Rig's decision and not a copy. */
    hostedCapabilitiesForRequest?: () => readonly HostedCapability[];
    models?: readonly Model[];
    /** Receives account usage a scripted response reports, as a real vendor would. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    prepareContext?: (model: Model, context: Context) => Context | Promise<Context>;
    providerId?: string;
    providerType?: Provider["type"];
    serviceTiers?: readonly ServiceTier[];
    token?: string;
}

export function createGymProvider(options: CreateGymProviderOptions) {
    const request = options.fetch ?? globalThis.fetch;
    const models = options.models ?? [gymModel];
    const providerId = options.providerId ?? "gym";
    const contextWindow = options.contextWindow;
    let providerSessionGeneration = 0;
    const configuredModels =
        contextWindow === undefined ? models : models.map((model) => ({ ...model, contextWindow }));
    return defineProvider({
        id: providerId,
        ...(options.providerType === undefined ? {} : { type: options.providerType }),
        ...(options.extendProfilePromptContext === undefined
            ? {}
            : { extendProfilePromptContext: options.extendProfilePromptContext }),
        models: configuredModels,
        ...(options.providerId === undefined
            ? { serviceTiers: ["fast"] as const }
            : options.serviceTiers === undefined
              ? {}
              : { serviceTiers: options.serviceTiers }),
        reset() {
            providerSessionGeneration += 1;
        },
        async compact({ context, model, signal }) {
            const response = await request(options.endpoint, {
                body: JSON.stringify({
                    context,
                    modelId: model.id,
                    options: { intent: "compaction" },
                    providerSessionGeneration,
                    providerId,
                } satisfies GymInferenceRequest),
                headers: {
                    "content-type": "application/json",
                    ...(options.token === undefined
                        ? {}
                        : { authorization: `Bearer ${options.token}` }),
                },
                method: "POST",
                ...(signal === undefined ? {} : { signal }),
            });
            if (!response.ok) {
                const detail = (await response.text()).trim();
                return {
                    status: "failed",
                    kind: "inference_error",
                    message:
                        detail.length === 0
                            ? `Gym compaction failed with HTTP ${response.status}.`
                            : `Gym compaction failed with HTTP ${response.status}: ${detail}`,
                    context,
                };
            }
            const reply = (await response.json()) as GymInferenceResponse;
            if (reply.compactionContext === undefined) {
                return {
                    status: "failed",
                    kind: "inference_error",
                    message: "Gym compaction response did not include a replacement context.",
                    context,
                };
            }
            return {
                status: "completed",
                context: reply.compactionContext,
                ...(reply.compactionSummary === undefined
                    ? {}
                    : { summary: reply.compactionSummary }),
                usage: reply.usage ?? zeroUsage(),
            };
        },
        stream(model, context, streamOptions = {}) {
            return createInferenceStream(async function* () {
                const runtimeModel = `# Runtime model\nModel ID: ${model.id}\nProvider ID: ${providerId}`;
                const preparedContext =
                    options.prepareContext === undefined
                        ? {
                              ...context,
                              systemPrompt: [
                                  context.systemPromptOverride,
                                  runtimeModel,
                                  context.systemPrompt,
                              ]
                                  .filter(
                                      (part): part is string =>
                                          part !== undefined && part.length > 0,
                                  )
                                  .join("\n\n"),
                          }
                        : await options.prepareContext(model, {
                              ...context,
                              systemPrompt: [runtimeModel, context.systemPrompt]
                                  .filter(
                                      (part): part is string =>
                                          part !== undefined && part.length > 0,
                                  )
                                  .join("\n\n"),
                          });
                const hostedSearches = options.hostedCapabilitiesForRequest?.() ?? [];
                const response = await request(options.endpoint, {
                    body: JSON.stringify({
                        context: preparedContext,
                        hostedSearches,
                        modelId: model.id,
                        options: streamOptions,
                        providerSessionGeneration,
                        providerId,
                    } satisfies GymInferenceRequest),
                    headers: {
                        "content-type": "application/json",
                        ...(options.token === undefined
                            ? {}
                            : { authorization: `Bearer ${options.token}` }),
                    },
                    method: "POST",
                    ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
                });
                if (!response.ok) {
                    const detail = (await response.text()).trim();
                    throw new Error(
                        detail.length === 0
                            ? `Gym inference failed with HTTP ${response.status}.`
                            : `Gym inference failed with HTTP ${response.status}: ${detail}`,
                    );
                }

                const reply = (await response.json()) as GymInferenceResponse;
                if (reply.accountUsage !== undefined) {
                    options.onAccountUsage?.({ ...reply.accountUsage, providerId });
                }
                if (reply.delayMs !== undefined) {
                    await delay(reply.delayMs, streamOptions);
                }
                const stopReason =
                    reply.stopReason ??
                    (reply.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
                const message: AssistantMessage = {
                    api: "gym",
                    content: [],
                    model: model.id,
                    provider: providerId,
                    role: "assistant",
                    ...(reply.contextTokens === undefined
                        ? {}
                        : { contextTokens: reply.contextTokens }),
                    ...(reply.responseModel === undefined
                        ? {}
                        : { responseModel: reply.responseModel }),
                    stopReason,
                    timestamp: Date.now(),
                    usage: reply.usage ?? zeroUsage(),
                    ...(reply.errorMessage === undefined
                        ? {}
                        : { errorMessage: reply.errorMessage }),
                    ...(reply.providerError === undefined
                        ? {}
                        : { providerError: reply.providerError }),
                };
                yield { type: "start", partial: message };

                for (const retry of reply.providerRetries ?? []) {
                    yield {
                        type: "retrying",
                        attempt: retry.attempt,
                        reason: retry.reason,
                    };
                    if (retry.delayMs !== undefined) {
                        await delay(retry.delayMs, streamOptions);
                    }
                }

                // A hosted call is answered by the provider itself, so it streams alongside the
                // response and never becomes a content block the client has to execute.
                for (const [index, serverToolCall] of (reply.serverToolCalls ?? []).entries()) {
                    const callId = serverToolCall.callId ?? `server-call-${String(index + 1)}`;
                    yield { type: "server_toolcall_start", callId, name: serverToolCall.name };
                    if (reply.serverToolCallDeltaDelayMs !== undefined) {
                        await delay(reply.serverToolCallDeltaDelayMs, streamOptions);
                    }
                    if (serverToolCall.arguments.length > 0) {
                        yield {
                            type: "server_toolcall_delta",
                            callId,
                            delta: serverToolCall.arguments,
                        };
                    }
                    const beforeEnd =
                        reply.serverToolCallEndDelayMs ?? reply.serverToolCallDeltaDelayMs;
                    if (beforeEnd !== undefined) {
                        await delay(beforeEnd, streamOptions);
                    }
                    yield {
                        type: "server_toolcall_end",
                        callId,
                        name: serverToolCall.name,
                        arguments: serverToolCall.arguments,
                    };
                }

                for (const block of reply.content) {
                    const contentIndex = message.content.length;
                    const stopped = yield* eventsForBlock(
                        contentIndex,
                        message,
                        block,
                        reply.errorAfterContentStart === true,
                        reply.disconnectAfterTextDeltas,
                        reply.errorAfterTextDeltas,
                        reply.thinkingDeltaChunkSize,
                        reply.thinkingDeltaDelayMs,
                        reply.textDeltaChunkSize,
                        reply.textDeltaDelayMs,
                        reply.toolCallDeltaDelayMs,
                        streamOptions,
                    );
                    if (stopped) break;
                }

                if (reply.completionDelayMs !== undefined && reply.completionDelayMs > 0) {
                    await delay(reply.completionDelayMs, streamOptions);
                }

                if (stopReason === "error" || stopReason === "aborted") {
                    const event: ProviderAssistantMessageEvent = {
                        type: "error",
                        reason: stopReason,
                        error: message,
                    };
                    yield event;
                    return message;
                }

                const event: ProviderAssistantMessageEvent = {
                    type: "done",
                    reason: stopReason,
                    message,
                };
                yield event;
                return message;
            });
        },
    });
}

async function* eventsForBlock(
    contentIndex: number,
    message: AssistantMessage,
    block: AssistantMessage["content"][number],
    stopAfterStart: boolean,
    disconnectAfterTextDeltas: number | undefined,
    errorAfterTextDeltas: number | undefined,
    thinkingDeltaChunkSize: number | undefined,
    thinkingDeltaDelayMs: number | undefined,
    textDeltaChunkSize: number | undefined,
    textDeltaDelayMs: number | undefined,
    toolCallDeltaDelayMs: number | undefined,
    streamOptions: StreamOptions,
): AsyncGenerator<ProviderAssistantMessageEvent, boolean> {
    if (block.type === "text") {
        const partialBlock = { type: "text" as const, text: "" };
        message.content = [...message.content, partialBlock];
        yield { type: "text_start", contentIndex, partial: message };
        if (stopAfterStart) return true;
        const requestedChunkSize = Math.floor(textDeltaChunkSize ?? block.text.length);
        const chunkSize = Number.isFinite(requestedChunkSize)
            ? Math.max(1, requestedChunkSize)
            : Math.max(1, block.text.length);
        if (block.text.length === 0) {
            yield { type: "text_delta", contentIndex, delta: "", partial: message };
        }
        let emittedDeltas = 0;
        for (let offset = 0; offset < block.text.length; offset += chunkSize) {
            const delta = block.text.slice(offset, offset + chunkSize);
            partialBlock.text += delta;
            yield {
                type: "text_delta",
                contentIndex,
                delta,
                partial: message,
            };
            emittedDeltas += 1;
            if (
                disconnectAfterTextDeltas !== undefined &&
                emittedDeltas >= disconnectAfterTextDeltas
            ) {
                throw new Error("WebSocket error");
            }
            if (errorAfterTextDeltas !== undefined && emittedDeltas >= errorAfterTextDeltas) {
                return true;
            }
            if (textDeltaDelayMs !== undefined && offset + chunkSize < block.text.length) {
                await delay(textDeltaDelayMs, streamOptions);
            }
        }
        yield { type: "text_end", contentIndex, content: block.text, partial: message };
        return false;
    }
    if (block.type === "thinking") {
        const partialBlock = { type: "thinking" as const, thinking: "" };
        message.content = [...message.content, partialBlock];
        yield { type: "thinking_start", contentIndex, partial: message };
        if (stopAfterStart) return true;
        const requestedChunkSize = Math.floor(thinkingDeltaChunkSize ?? block.thinking.length);
        const chunkSize = Number.isFinite(requestedChunkSize)
            ? Math.max(1, requestedChunkSize)
            : Math.max(1, block.thinking.length);
        if (block.thinking.length === 0) {
            yield { type: "thinking_delta", contentIndex, delta: "", partial: message };
        }
        for (let offset = 0; offset < block.thinking.length; offset += chunkSize) {
            const delta = block.thinking.slice(offset, offset + chunkSize);
            partialBlock.thinking += delta;
            yield {
                type: "thinking_delta",
                contentIndex,
                delta,
                partial: message,
            };
            if (thinkingDeltaDelayMs !== undefined && offset + chunkSize < block.thinking.length) {
                await delay(thinkingDeltaDelayMs, streamOptions);
            }
        }
        yield {
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: message,
        };
        return false;
    }
    message.content = [...message.content, block];
    yield { type: "toolcall_start", contentIndex, partial: message };
    if (stopAfterStart) return true;
    if (toolCallDeltaDelayMs !== undefined) {
        await delay(toolCallDeltaDelayMs, streamOptions);
    }
    yield {
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(block.arguments),
        partial: message,
    };
    yield { type: "toolcall_end", contentIndex, toolCall: block, partial: message };
    return false;
}

function zeroUsage(): Usage {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}

async function delay(ms: number, options: StreamOptions): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const finish = () => {
            options.signal?.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        const abort = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            reject(options.signal?.reason ?? new Error("Gym inference was aborted."));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
    });
}
