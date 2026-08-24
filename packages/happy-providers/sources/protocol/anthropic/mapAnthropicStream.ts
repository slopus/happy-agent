import type {
    BetaRawMessageStreamEvent,
    BetaStopReason,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { APIConnectionError } from "@anthropic-ai/sdk/error";

import { EmptyResponseError } from "@/core/EmptyResponseError.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import type { SessionToolCallBlock, SessionToolResultBlock } from "@/core/SessionContext.js";
import { emitToolCallResult } from "@/core/emitToolCallResult.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { toAnthropicToolName } from "@/protocol/anthropic/toAnthropicToolName.js";
import { type AnthropicReasoningState } from "@/protocol/anthropic/toAnthropicMessages.js";

type AnthropicReplayBlock =
    | AnthropicReasoningState
    | { type: "text"; text: string }
    | SessionToolCallBlock
    | SessionToolResultBlock;

export async function* mapAnthropicStream(
    stream: AsyncIterable<BetaRawMessageStreamEvent>,
    options: {
        onOutputStarted?: () => void;
        signal?: AbortSignal;
        tools?: readonly SessionTool[];
    } = {},
): AsyncGenerator<SessionEvent> {
    const blocks = new Map<number, AnthropicReplayBlock>();
    const tools = new Map<
        number,
        {
            callId: string;
            name: string;
            namespace?: string;
            wireName: string;
            arguments: string;
            input: Record<string, unknown>;
            serverOutputBlock?: Record<string, unknown>;
            server?: true;
        }
    >();
    let usage: SessionUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
    };
    let outputTokensReported = false;
    let stopReason: BetaStopReason | null = null;
    let sawCompaction = false;
    let sawClientTool = false;
    let started = false;
    for await (const event of stream) {
        if (!started) {
            started = true;
            yield { type: "block_start" };
        }
        if (event.type === "message_start") {
            usage = toUsage(event.message.usage);
            outputTokensReported = typeof event.message.usage.output_tokens === "number";
            continue;
        }
        if (event.type === "content_block_start") {
            if (
                event.content_block.type === "tool_use" ||
                event.content_block.type === "server_tool_use"
            ) {
                const wireName = event.content_block.name;
                const configured = options.tools?.find(
                    (tool) => anthropicToolWireName(tool) === wireName,
                );
                const server =
                    event.content_block.type === "server_tool_use" ||
                    configured?.server !== undefined ||
                    options.tools?.some(
                        (tool) =>
                            tool.server !== undefined && anthropicToolWireName(tool) === wireName,
                    ) === true;
                const input = asObjectInput(event.content_block.input);
                const initialArguments =
                    event.content_block.type === "server_tool_use" && Object.keys(input).length > 0
                        ? JSON.stringify(input)
                        : "";
                const tool = {
                    callId: event.content_block.id,
                    name: configured?.name ?? event.content_block.name,
                    ...(configured?.namespace === undefined
                        ? {}
                        : { namespace: configured.namespace }),
                    wireName,
                    arguments: "",
                    input,
                    ...(event.content_block.type === "server_tool_use"
                        ? {
                              serverOutputBlock: structuredClone(
                                  event.content_block,
                              ) as unknown as Record<string, unknown>,
                          }
                        : {}),
                    ...(server ? { server: true as const } : {}),
                };
                tools.set(event.index, tool);
                if (!server) sawClientTool = true;
                yield {
                    type: "toolcall_start",
                    callId: tool.callId,
                    name: tool.name,
                    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
                    ...(server ? { server: true as const } : {}),
                    vendor: {
                        type: "claude_tool_use",
                    },
                };
                if (initialArguments.length > 0) {
                    yield {
                        type: "toolcall_delta",
                        callId: tool.callId,
                        delta: initialArguments,
                    };
                }
            } else if (isAnthropicServerToolResultBlock(event.content_block)) {
                const callId = event.content_block.tool_use_id;
                const result = JSON.stringify(event.content_block.content ?? null);
                blocks.set(event.index, {
                    type: "tool_result",
                    callId,
                    content: [{ type: "text", text: result }],
                    vendor: { outputBlock: JSON.stringify(event.content_block) },
                });
                yield* emitToolCallResult(callId, result, {
                    vendor: { outputBlock: JSON.stringify(event.content_block) },
                });
            } else if (event.content_block.type === "thinking") {
                blocks.set(event.index, {
                    type: "thinking",
                    thinking: event.content_block.thinking,
                    signature: event.content_block.signature,
                });
                yield { type: "reasoning_start" };
                if (event.content_block.thinking.length > 0) {
                    yield {
                        type: "reasoning_delta",
                        delta: event.content_block.thinking,
                    };
                }
            } else if (event.content_block.type === "redacted_thinking") {
                blocks.set(event.index, event.content_block);
                yield { type: "reasoning_start" };
            } else if (event.content_block.type === "text") {
                blocks.set(event.index, {
                    type: "text",
                    text: event.content_block.text,
                });
                yield { type: "text_start" };
                if (event.content_block.text.length > 0) {
                    yield { type: "text_delta", delta: event.content_block.text };
                }
            } else if (event.content_block.type === "compaction") {
                sawCompaction = true;
                options.onOutputStarted?.();
            }
            continue;
        }
        if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
                const current = blocks.get(event.index);
                if (current?.type === "text") {
                    blocks.set(event.index, {
                        type: "text",
                        text: current.text + event.delta.text,
                    });
                }
                yield { type: "text_delta", delta: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
                const current = blocks.get(event.index);
                if (current?.type === "thinking") {
                    blocks.set(event.index, {
                        ...current,
                        thinking: current.thinking + event.delta.thinking,
                    });
                }
                yield { type: "reasoning_delta", delta: event.delta.thinking };
            } else if (event.delta.type === "signature_delta") {
                const current = blocks.get(event.index);
                if (current?.type === "thinking") {
                    blocks.set(event.index, {
                        ...current,
                        signature: current.signature + event.delta.signature,
                    });
                }
            } else if (event.delta.type === "input_json_delta") {
                const current = tools.get(event.index);
                if (current !== undefined) {
                    current.arguments += event.delta.partial_json;
                    yield {
                        type: "toolcall_delta",
                        callId: current.callId,
                        delta: event.delta.partial_json,
                    };
                }
            } else if (event.delta.type === "compaction_delta") {
                sawCompaction = true;
                options.onOutputStarted?.();
            }
            continue;
        }
        if (event.type === "content_block_stop") {
            const block = blocks.get(event.index);
            if (block?.type === "thinking" || block?.type === "redacted_thinking") {
                yield {
                    type: "reasoning_end",
                    reasoning: block.type === "thinking" ? block.signature : block.data,
                };
            }
            if (block?.type === "text") yield { type: "text_end" };
            const tool = tools.get(event.index);
            if (tool !== undefined) {
                const input = parseArguments(tool.arguments, tool.input);
                const argumentsJson = JSON.stringify(input);
                const outputBlock =
                    tool.serverOutputBlock === undefined
                        ? undefined
                        : JSON.stringify({ ...tool.serverOutputBlock, input });
                const vendor = {
                    type: "claude_tool_use",
                    wireName: tool.wireName,
                    ...(outputBlock === undefined ? {} : { outputBlock }),
                };
                blocks.set(event.index, {
                    type: "tool_call",
                    callId: tool.callId,
                    name: tool.name,
                    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
                    arguments: argumentsJson,
                    ...(tool.server === undefined ? {} : { server: true }),
                    vendor,
                });
                yield {
                    type: "toolcall_end",
                    callId: tool.callId,
                    arguments: argumentsJson,
                    vendor,
                };
            }
            continue;
        }
        if (event.type === "message_delta") {
            usage = mergeUsage(usage, event.usage);
            if (typeof event.usage.output_tokens === "number") outputTokensReported = true;
            stopReason = event.delta.stop_reason;
            if (stopReason === "compaction") options.onOutputStarted?.();
            continue;
        }
        if (event.type === "message_stop") {
            const terminal = toDoneEvent(stopReason, sawClientTool, sawCompaction, usage);
            if (
                terminal.state !== "error" &&
                terminal.state !== "cancelled" &&
                outputTokensReported &&
                usage.output === 0
            ) {
                throw new EmptyResponseError("Anthropic Bedrock", usage);
            }
            yield { type: "token_usage", usage };
            yield { type: "block_stop" };
            yield terminal;
            return;
        }
    }
    if (options.signal?.aborted) throw options.signal.reason;
    if (sawCompaction || stopReason === "compaction") {
        yield { type: "token_usage", usage };
        yield { type: "block_stop" };
        yield toDoneEvent(stopReason, sawClientTool, sawCompaction, usage);
        return;
    }
    throw new APIConnectionError({
        message: "Anthropic Bedrock connection closed before returning message_stop.",
    });
}

function anthropicToolWireName(tool: SessionTool): string {
    const nativeName = tool.server?.name;
    return typeof nativeName === "string" ? nativeName : toAnthropicToolName(tool);
}

function isAnthropicServerToolResultBlock(
    block: unknown,
): block is { type: string; tool_use_id: string; content?: unknown } {
    if (typeof block !== "object" || block === null) return false;
    if (!("type" in block) || typeof block.type !== "string") return false;
    if (!block.type.endsWith("_tool_result")) return false;
    return "tool_use_id" in block && typeof block.tool_use_id === "string";
}

function parseArguments(
    argumentsJson: string,
    fallback: Record<string, unknown>,
): Record<string, unknown> {
    if (argumentsJson.length === 0) return fallback;
    try {
        const value: unknown = JSON.parse(argumentsJson);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : fallback;
    } catch {
        return fallback;
    }
}

function asObjectInput(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
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

function toDoneEvent(
    stopReason: BetaStopReason | null,
    sawTool: boolean,
    sawCompaction: boolean,
    usage: SessionUsage,
): Extract<SessionEvent, { type: "done" }> {
    if (sawCompaction || stopReason === "compaction") {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "Anthropic returned an unexpected compaction response during inference.",
            providerError: { type: "unclassified" },
        };
    }
    if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
        return {
            type: "done",
            state: "length",
            tokens: { input: usage.input, output: usage.output },
        };
    }
    if (stopReason === "refusal") {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "The model refused to complete the request.",
            providerError: { type: "unclassified" },
        };
    }
    if (sawTool || stopReason === "tool_use") {
        return {
            type: "done",
            state: "tool_call",
            tokens: { input: usage.input, output: usage.output },
        };
    }
    return {
        type: "done",
        state: "normal",
        tokens: { input: usage.input, output: usage.output },
    };
}
