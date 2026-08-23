import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { createServerCitationFilter } from "./stripServerCitationMarkers.js";

import { EMPTY_SESSION_USAGE, type SessionUsage } from "@/core/SessionUsage.js";
import type {
    SessionAssistantBlock,
    SessionAssistantMessage,
    SessionToolCallBlock,
} from "@/core/SessionContext.js";
import { emitToolCallResult } from "@/core/emitToolCallResult.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { withProviderToolCallId } from "@/core/SessionToolCallId.js";
import { toSessionUsage } from "@/protocol/responses/toSessionUsage.js";
import type {
    ResponsesToolCallType,
    ResponsesToolVendor,
} from "@/protocol/responses/ResponsesToolVendor.js";
import { responseStreamError } from "@/protocol/responses/responseStreamError.js";

/** Call-id prefix the provider puts on searches it ran itself; client calls never carry it. */
const HOSTED_SEARCH_CALL_PREFIX = "xs_";

const completedResponseExtensionSchema = Type.Object({
    end_turn: Type.Optional(Type.Boolean()),
});

interface ActiveOutputItem {
    callId?: string;
    name?: string;
    namespace?: string;
    type:
        | "message"
        | "reasoning"
        | "function_call"
        | "custom_tool_call"
        | "tool_search_call"
        | "server_tool_call";
    argumentsJson?: string;
    streamedText?: string;
}

export interface OpenAIResponseRunResult {
    assistantText: string;
    message: SessionAssistantMessage;
    outputTokensReported: boolean;
    /** Provider output retained only for provider-internal follow-up requests. */
    outputItems: readonly string[];
    stopReason: "stop" | "length" | "tool_use";
    toolCalls: readonly CollectedToolCall[];
    usage: SessionUsage;
}

type CollectedToolCall = Omit<SessionToolCallBlock, "type">;

/**
 * Maps the OpenAI Responses event protocol shared by Codex, Grok, and Bedrock Mantle.
 *
 * The vendor only selects how tool-call metadata is stamped; the event grammar is identical.
 * It defaults to Grok, so Codex callers must pass it explicitly.
 */
export async function* mapOpenAIResponseStream(
    responseStream: AsyncIterable<ResponseStreamEvent>,
    options: {
        signal?: AbortSignal;
        failureMessage: string;
        requireTerminalEvent?: boolean;
        vendor?: "codex" | "grok" | "responses";
        /** Names of the `server: true` tools carried by this exact request. */
        serverToolNames?: ReadonlySet<string>;
    },
): AsyncGenerator<SessionEvent, OpenAIResponseRunResult> {
    const activeItems = new Map<number, ActiveOutputItem>();
    let assistantText = "";
    // Server search leaves citation markers in the prose that only OpenAI's backend can resolve.
    const stripCitations = createServerCitationFilter();
    let encryptedReasoning: string | undefined;
    let sawToolUse = false;
    const toolCalls: CollectedToolCall[] = [];
    const outputItems = new Map<number, string>();
    const finishedServerToolCalls = new Set<string>();
    const finishedMessageItems = new Set<number>();
    const finishedReasoningItems = new Set<number>();
    const fallbackCallIdScope = randomUUID();
    let usage: SessionUsage = { ...EMPTY_SESSION_USAGE };
    let outputTokensReported = false;

    const finish = (stopReason: OpenAIResponseRunResult["stopReason"]): OpenAIResponseRunResult => {
        const orderedOutputItems = [...outputItems.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => item);
        return {
            assistantText,
            message: toSessionAssistantMessage(
                orderedOutputItems,
                toolCalls,
                options,
                fallbackCallIdScope,
            ),
            outputTokensReported,
            outputItems: orderedOutputItems,
            stopReason,
            toolCalls,
            usage,
        };
    };

    try {
        for await (const event of responseStream) {
            if (
                options.signal?.aborted &&
                event.type !== "response.completed" &&
                event.type !== "response.incomplete" &&
                event.type !== "response.failed" &&
                event.type !== "error"
            ) {
                yield* settleServerToolCalls(
                    activeItems,
                    [],
                    finishedServerToolCalls,
                    options,
                    fallbackCallIdScope,
                    true,
                );
                return finish("stop");
            }

            if (event.type === "response.output_item.added") {
                assertValidToolCallItem(event.item, { allowMissingServerAction: true });
                assertServerCallWasDeclared(event.item, options);
                if (event.item.type === "reasoning") {
                    activeItems.set(event.output_index, { type: "reasoning" });
                    yield { type: "reasoning_start" };
                } else if (event.item.type === "message") {
                    activeItems.set(event.output_index, { type: "message" });
                    yield { type: "text_start" };
                } else if (event.item.type === "function_call") {
                    sawToolUse = true;
                    activeItems.set(event.output_index, {
                        type: "function_call",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        argumentsJson: event.item.arguments,
                    });
                    yield {
                        type: "toolcall_start",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        vendor: responseToolVendor(options.vendor, "function_call"),
                    };
                    if (event.item.arguments.length > 0) {
                        yield {
                            type: "toolcall_delta",
                            callId: event.item.call_id,
                            delta: event.item.arguments,
                        };
                    }
                } else if (
                    event.item.type === "custom_tool_call" &&
                    serverExecutedItemName(event.item, options) !== undefined
                ) {
                    activeItems.set(event.output_index, {
                        type: "server_tool_call",
                        callId: event.item.call_id,
                        name: event.item.name,
                        argumentsJson: event.item.input,
                    });
                    yield {
                        type: "toolcall_start",
                        callId: event.item.call_id,
                        name: event.item.name,
                        server: true,
                    };
                    if (event.item.input.length > 0) {
                        yield {
                            type: "toolcall_delta",
                            callId: event.item.call_id,
                            delta: event.item.input,
                        };
                    }
                } else if (event.item.type === "custom_tool_call") {
                    sawToolUse = true;
                    activeItems.set(event.output_index, {
                        type: "custom_tool_call",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        argumentsJson: event.item.input,
                    });
                    yield {
                        type: "toolcall_start",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                    };
                    if (event.item.input.length > 0) {
                        yield {
                            type: "toolcall_delta",
                            callId: event.item.call_id,
                            delta: event.item.input,
                        };
                    }
                } else if (
                    event.item.type === "tool_search_call" &&
                    event.item.execution === "client" &&
                    event.item.call_id !== null
                ) {
                    sawToolUse = true;
                    const argumentsJson = JSON.stringify(event.item.arguments);
                    activeItems.set(event.output_index, {
                        type: "tool_search_call",
                        callId: event.item.call_id,
                        name: "tool_search",
                        argumentsJson,
                    });
                    yield {
                        type: "toolcall_start",
                        callId: event.item.call_id,
                        name: "tool_search",
                        vendor: responseToolVendor(options.vendor, "tool_search_call"),
                    };
                    yield {
                        type: "toolcall_delta",
                        callId: event.item.call_id,
                        delta: argumentsJson,
                    };
                } else {
                    const name = serverExecutedItemName(event.item, options);
                    if (name !== undefined) {
                        const callId = serverToolCallId(
                            event.item,
                            event.output_index,
                            fallbackCallIdScope,
                        );
                        activeItems.set(event.output_index, {
                            type: "server_tool_call",
                            callId,
                            name,
                        });
                        yield { type: "toolcall_start", callId, name, server: true };
                    }
                }
                continue;
            }

            if (
                event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta"
            ) {
                const activeItem = activeItems.get(event.output_index);
                if (activeItem?.type !== "reasoning") continue;
                activeItem.streamedText = (activeItem.streamedText ?? "") + event.delta;
                yield { type: "reasoning_delta", delta: event.delta };
                continue;
            }

            if (event.type === "response.reasoning_summary_part.done") {
                const activeItem = activeItems.get(event.output_index);
                if (activeItem?.type === "reasoning") {
                    activeItem.streamedText = (activeItem.streamedText ?? "") + "\n\n";
                }
                yield { type: "reasoning_delta", delta: "\n\n" };
                continue;
            }

            if (
                event.type === "response.output_text.delta" ||
                event.type === "response.refusal.delta"
            ) {
                const activeItem = activeItems.get(event.output_index);
                if (activeItem?.type !== "message") continue;
                const delta = stripCitations(event.delta);
                activeItem.streamedText = (activeItem.streamedText ?? "") + delta;
                assistantText += delta;
                // A delta that was nothing but a marker is not a pause in the answer; saying so would
                // put an empty block in the transcript.
                if (delta.length === 0) continue;
                yield { type: "text_delta", delta };
                continue;
            }

            if (event.type === "response.function_call_arguments.delta") {
                const activeItem = activeItems.get(event.output_index);
                if (activeItem?.type !== "function_call" || activeItem.callId === undefined)
                    continue;
                activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
                yield {
                    type: "toolcall_delta",
                    callId: activeItem.callId,
                    delta: event.delta,
                };
                continue;
            }

            if (event.type === "response.custom_tool_call_input.delta") {
                const activeItem = activeItems.get(event.output_index);
                if (activeItem?.callId === undefined) continue;
                if (activeItem.type === "server_tool_call") {
                    activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
                    yield {
                        type: "toolcall_delta",
                        callId: activeItem.callId,
                        delta: event.delta,
                    };
                    continue;
                }
                if (activeItem.type !== "custom_tool_call") continue;
                activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
                yield {
                    type: "toolcall_delta",
                    callId: activeItem.callId,
                    delta: event.delta,
                };
                continue;
            }

            if (event.type === "response.output_item.done") {
                assertValidToolCallItem(event.item);
                assertServerCallWasDeclared(event.item, options);
                const activeItem = activeItems.get(event.output_index);
                outputItems.set(event.output_index, JSON.stringify(event.item));
                if (event.item.type === "reasoning") {
                    encryptedReasoning = JSON.stringify(event.item);
                    if (activeItem?.type !== "reasoning") yield { type: "reasoning_start" };
                    const finalText = reasoningText(
                        event.item as unknown as Record<string, unknown>,
                    );
                    const missingText = missingTerminalText(
                        activeItem?.streamedText,
                        finalText ?? "",
                    );
                    if (missingText.length > 0) {
                        yield { type: "reasoning_delta", delta: missingText };
                    }
                    yield { type: "reasoning_end", reasoning: encryptedReasoning };
                    finishedReasoningItems.add(event.output_index);
                }
                if (event.item.type === "message") {
                    if (activeItem?.type !== "message") yield { type: "text_start" };
                    const finalText = stripCitations(messageText(event.item));
                    const missingText = missingTerminalText(activeItem?.streamedText, finalText);
                    if (missingText.length > 0) {
                        assistantText += missingText;
                        yield { type: "text_delta", delta: missingText };
                    }
                    yield { type: "text_end" };
                    finishedMessageItems.add(event.output_index);
                }
                const serverToolName =
                    activeItem?.type === "server_tool_call"
                        ? activeItem.name
                        : serverExecutedItemName(event.item, options);
                if (serverToolName !== undefined) {
                    const callId =
                        activeItem?.callId ??
                        serverToolCallId(event.item, event.output_index, fallbackCallIdScope);
                    const argumentsJson = serverToolCallArguments(event.item);
                    const incomplete = isIncompleteServerToolCall(event.item);
                    if (activeItem === undefined) {
                        yield {
                            type: "toolcall_start",
                            callId,
                            name: serverToolName,
                            server: true,
                        };
                    }
                    yield {
                        type: "toolcall_end",
                        callId,
                        arguments: argumentsJson,
                        ...(incomplete ? { incomplete: true as const } : {}),
                    };
                    // Sources and other provider-owned outcomes ride beside the call, not inside
                    // the executor tool loop. Emit them only when the item actually carries a
                    // result so X-search-style calls without a payload stay call-only.
                    const result = serverToolCallResult(event.item);
                    if (result !== undefined) {
                        yield* emitToolCallResult(callId, result, {
                            ...(incomplete ? { incomplete: true } : {}),
                        });
                    }
                    finishedServerToolCalls.add(callId);
                    activeItems.delete(event.output_index);
                    continue;
                }
                if (
                    event.item.type === "function_call" &&
                    (activeItem === undefined || activeItem.type === "function_call")
                ) {
                    if (activeItem === undefined) {
                        sawToolUse = true;
                        yield {
                            type: "toolcall_start",
                            callId: event.item.call_id,
                            name: event.item.name,
                            ...(event.item.namespace === undefined
                                ? {}
                                : { namespace: event.item.namespace }),
                            vendor: responseToolVendor(options.vendor, "function_call"),
                        };
                        if (event.item.arguments.length > 0) {
                            yield {
                                type: "toolcall_delta",
                                callId: event.item.call_id,
                                delta: event.item.arguments,
                            };
                        }
                    }
                    toolCalls.push({
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        arguments: event.item.arguments,
                        ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                        vendor: responseToolVendor(options.vendor, "function_call"),
                    });
                    yield {
                        type: "toolcall_end",
                        callId: event.item.call_id,
                        arguments: event.item.arguments,
                        ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                    };
                }
                if (
                    event.item.type === "custom_tool_call" &&
                    (activeItem === undefined || activeItem.type === "custom_tool_call")
                ) {
                    if (activeItem === undefined) {
                        sawToolUse = true;
                        yield {
                            type: "toolcall_start",
                            callId: event.item.call_id,
                            name: event.item.name,
                            ...(event.item.namespace === undefined
                                ? {}
                                : { namespace: event.item.namespace }),
                            vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                        };
                        if (event.item.input.length > 0) {
                            yield {
                                type: "toolcall_delta",
                                callId: event.item.call_id,
                                delta: event.item.input,
                            };
                        }
                    }
                    toolCalls.push({
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        arguments: event.item.input,
                        ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                        vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                    });
                    yield {
                        type: "toolcall_end",
                        callId: event.item.call_id,
                        arguments: event.item.input,
                        ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                    };
                }
                if (
                    event.item.type === "tool_search_call" &&
                    event.item.execution === "client" &&
                    event.item.call_id !== null
                ) {
                    const callId = event.item.call_id;
                    const argumentsJson = JSON.stringify(event.item.arguments);
                    if (activeItem?.type !== "tool_search_call") {
                        sawToolUse = true;
                        yield {
                            type: "toolcall_start",
                            callId,
                            name: "tool_search",
                            vendor: responseToolVendor(options.vendor, "tool_search_call"),
                        };
                        yield {
                            type: "toolcall_delta",
                            callId,
                            delta: argumentsJson,
                        };
                    }
                    toolCalls.push({
                        callId,
                        name: "tool_search",
                        arguments: argumentsJson,
                        vendor: responseToolVendor(options.vendor, "tool_search_call"),
                    });
                    yield {
                        type: "toolcall_end",
                        callId,
                        arguments: argumentsJson,
                    };
                }
                activeItems.delete(event.output_index);
                continue;
            }

            if (event.type === "response.incomplete") {
                const reason = event.response.incomplete_details?.reason ?? "unknown";
                for (const item of event.response.output ?? []) {
                    assertValidToolCallItem(item);
                    assertServerCallWasDeclared(item, options);
                }
                for (const [outputIndex, item] of (event.response.output ?? []).entries()) {
                    outputItems.set(outputIndex, JSON.stringify(item));
                }
                yield* settleServerToolCalls(
                    activeItems,
                    event.response.output ?? [],
                    finishedServerToolCalls,
                    options,
                    fallbackCallIdScope,
                    true,
                );
                yield* settleTerminalReasoningBlocks(
                    activeItems,
                    event.response.output ?? [],
                    finishedReasoningItems,
                );
                yield* settleTerminalMessageText(
                    activeItems,
                    event.response.output ?? [],
                    stripCitations,
                    finishedMessageItems,
                    (delta) => {
                        assistantText += delta;
                    },
                );
                yield* closeRemainingResponseContentBlocks(activeItems);
                for (const [outputIndex, activeItem] of activeItems) {
                    if (
                        (activeItem.type !== "function_call" &&
                            activeItem.type !== "custom_tool_call" &&
                            activeItem.type !== "tool_search_call") ||
                        activeItem.callId === undefined ||
                        activeItem.name === undefined ||
                        toolCalls.some((toolCall) => toolCall.callId === activeItem.callId)
                    ) {
                        continue;
                    }
                    const argumentsJson = activeItem.argumentsJson ?? "";
                    const vendorType =
                        activeItem.type === "custom_tool_call"
                            ? "custom_tool_call"
                            : activeItem.type === "tool_search_call"
                              ? "tool_search_call"
                              : "function_call";
                    toolCalls.push({
                        callId: activeItem.callId,
                        name: activeItem.name,
                        ...(activeItem.namespace === undefined
                            ? {}
                            : { namespace: activeItem.namespace }),
                        arguments: argumentsJson,
                        incomplete: true,
                        vendor: responseToolVendor(options.vendor, vendorType),
                    });
                    yield {
                        type: "toolcall_end",
                        callId: activeItem.callId,
                        arguments: argumentsJson,
                        incomplete: true,
                    };
                    activeItems.delete(outputIndex);
                }
                sawToolUse =
                    (yield* settleTerminalClientToolCalls(
                        event.response.output ?? [],
                        toolCalls,
                        options.vendor,
                        true,
                        options.serverToolNames,
                    )) || sawToolUse;
                usage = toSessionUsage(event.response.usage);
                outputTokensReported = hasReportedOutputTokens(event.response.usage);
                if (usage.totalTokens > 0) {
                    yield { type: "token_usage", usage };
                }
                if (reason === "max_output_tokens") {
                    yield {
                        type: "done",
                        state: "length",
                        tokens: { input: usage.input, output: usage.output },
                    };
                    return finish("length");
                }
                throw new Error(`Incomplete response returned, reason: ${reason}`);
            }

            if (event.type === "response.completed") {
                for (const item of event.response.output ?? []) {
                    assertValidToolCallItem(item);
                    assertServerCallWasDeclared(item, options);
                }
                for (const [outputIndex, item] of (event.response.output ?? []).entries()) {
                    outputItems.set(outputIndex, JSON.stringify(item));
                }
                yield* settleServerToolCalls(
                    activeItems,
                    event.response.output ?? [],
                    finishedServerToolCalls,
                    options,
                    fallbackCallIdScope,
                );
                yield* settleTerminalReasoningBlocks(
                    activeItems,
                    event.response.output ?? [],
                    finishedReasoningItems,
                );
                yield* settleTerminalMessageText(
                    activeItems,
                    event.response.output ?? [],
                    stripCitations,
                    finishedMessageItems,
                    (delta) => {
                        assistantText += delta;
                    },
                );
                yield* closeRemainingResponseContentBlocks(activeItems);
                for (const [outputIndex, activeItem] of activeItems) {
                    if (
                        (activeItem.type !== "function_call" &&
                            activeItem.type !== "custom_tool_call" &&
                            activeItem.type !== "tool_search_call") ||
                        activeItem.callId === undefined ||
                        activeItem.name === undefined
                    ) {
                        continue;
                    }
                    const completedItem = (event.response.output ?? []).find(
                        (item) =>
                            (item.type === "function_call" ||
                                item.type === "custom_tool_call" ||
                                item.type === "tool_search_call") &&
                            item.call_id === activeItem.callId,
                    );
                    const vendorType =
                        activeItem.type === "custom_tool_call"
                            ? "custom_tool_call"
                            : activeItem.type === "tool_search_call"
                              ? "tool_search_call"
                              : "function_call";
                    const argumentsJson =
                        completedItem?.type === "custom_tool_call"
                            ? completedItem.input
                            : completedItem?.type === "function_call"
                              ? completedItem.arguments
                              : completedItem?.type === "tool_search_call"
                                ? JSON.stringify(completedItem.arguments)
                                : (activeItem.argumentsJson ?? "");
                    toolCalls.push({
                        callId: activeItem.callId,
                        name: activeItem.name,
                        ...(activeItem.namespace === undefined
                            ? {}
                            : { namespace: activeItem.namespace }),
                        arguments: argumentsJson,
                        vendor: responseToolVendor(options.vendor, vendorType),
                    });
                    yield {
                        type: "toolcall_end",
                        callId: activeItem.callId,
                        arguments: argumentsJson,
                    };
                    activeItems.delete(outputIndex);
                }
                sawToolUse =
                    (yield* settleTerminalClientToolCalls(
                        event.response.output ?? [],
                        toolCalls,
                        options.vendor,
                        false,
                        options.serverToolNames,
                    )) || sawToolUse;
                usage = toSessionUsage(event.response.usage);
                outputTokensReported = hasReportedOutputTokens(event.response.usage);
                const completedResponse = Value.Check(
                    completedResponseExtensionSchema,
                    event.response,
                )
                    ? event.response
                    : undefined;
                yield { type: "token_usage", usage };
                yield {
                    type: "done",
                    state: sawToolUse ? "tool_call" : "normal",
                    tokens: { input: usage.input, output: usage.output },
                    ...(!sawToolUse && completedResponse?.end_turn !== undefined
                        ? { endTurn: completedResponse.end_turn }
                        : {}),
                };
                return finish(sawToolUse ? "tool_use" : "stop");
            }

            if (event.type === "error") {
                yield* settleServerToolCalls(
                    activeItems,
                    [],
                    finishedServerToolCalls,
                    options,
                    fallbackCallIdScope,
                    true,
                );
                throw responseStreamError(event, options.failureMessage);
            }

            if (event.type === "response.failed") {
                yield* settleServerToolCalls(
                    activeItems,
                    event.response.output ?? [],
                    finishedServerToolCalls,
                    options,
                    fallbackCallIdScope,
                    true,
                );
                throw responseStreamError(event, options.failureMessage);
            }
        }
    } catch (error) {
        yield* settleServerToolCalls(
            activeItems,
            [],
            finishedServerToolCalls,
            options,
            fallbackCallIdScope,
            true,
        );
        throw error;
    }

    if (options.requireTerminalEvent) {
        yield* settleServerToolCalls(
            activeItems,
            [],
            finishedServerToolCalls,
            options,
            fallbackCallIdScope,
            true,
        );
        throw new Error("Response stream closed before completion.");
    }
    yield { type: "token_usage", usage };
    yield {
        type: "done",
        state: sawToolUse ? "tool_call" : "normal",
        tokens: { input: usage.input, output: usage.output },
    };
    return finish(sawToolUse ? "tool_use" : "stop");
}

function toSessionAssistantMessage(
    outputItems: readonly string[],
    toolCalls: readonly CollectedToolCall[],
    options: {
        vendor?: "codex" | "grok" | "responses";
        serverToolNames?: ReadonlySet<string>;
    },
    fallbackCallIdScope: string,
): SessionAssistantMessage {
    const stripCitations = createServerCitationFilter();
    const content = outputItems.flatMap((encoded, outputIndex): SessionAssistantBlock[] => {
        let item: unknown;
        try {
            item = JSON.parse(encoded);
        } catch {
            return [];
        }
        if (isItemType(item, "reasoning")) {
            const text = reasoningText(item);
            return [
                {
                    type: "reasoning",
                    ...(text === undefined ? {} : { text }),
                    reasoning: encoded,
                },
            ];
        }
        if (isItemType(item, "message")) {
            const text = outputMessageText(item);
            return text === undefined ? [] : [{ type: "text", text: stripCitations(text) }];
        }
        const serverName = serverExecutedItemName(item, options);
        if (serverName !== undefined) {
            const callId = serverToolCallId(item, outputIndex, fallbackCallIdScope);
            const incomplete = isIncompleteServerToolCall(item);
            const result = serverToolCallResult(item);
            return [
                {
                    type: "tool_call",
                    callId,
                    name: serverName,
                    arguments: serverToolCallArguments(item),
                    server: true,
                    ...(incomplete ? { incomplete: true } : {}),
                    vendor: {
                        provider: options.vendor ?? "grok",
                        type: "server_tool_call",
                        outputItem: encoded,
                        providerCallId: callId,
                    },
                },
                ...(result === undefined
                    ? []
                    : [
                          {
                              type: "tool_result" as const,
                              callId,
                              content: [{ type: "text" as const, text: result }],
                              ...(incomplete ? { incomplete: true } : {}),
                          },
                      ]),
            ];
        }
        const parsed = asOutputItem(item);
        const callId = parsed?.call_id;
        if (callId === undefined) return [];
        const call = toolCalls.find((candidate) => candidate.callId === callId);
        return call === undefined
            ? []
            : [
                  {
                      type: "tool_call",
                      ...call,
                      vendor: withProviderToolCallId(call.vendor, call.callId),
                  },
              ];
    });
    return { role: "assistant", content };
}

function isItemType(
    item: unknown,
    type: string,
): item is Record<string, unknown> & { type: string } {
    return typeof item === "object" && item !== null && "type" in item && item.type === type;
}

function reasoningText(item: Record<string, unknown>): string | undefined {
    const parts = [item.summary, item.content]
        .filter(Array.isArray)
        .flatMap((value) => value as unknown[])
        .flatMap((part) => {
            if (typeof part !== "object" || part === null) return [];
            if ("text" in part && typeof part.text === "string") return [part.text];
            return [];
        });
    return parts.length === 0 ? undefined : parts.join("\n\n");
}

function outputMessageText(item: Record<string, unknown>): string | undefined {
    if (!Array.isArray(item.content)) return undefined;
    const parts = item.content.flatMap((part): string[] => {
        if (typeof part !== "object" || part === null || !("type" in part)) return [];
        if (part.type === "output_text" && "text" in part && typeof part.text === "string") {
            return [part.text];
        }
        if (part.type === "refusal" && "refusal" in part && typeof part.refusal === "string") {
            return [part.refusal];
        }
        return [];
    });
    return parts.length === 0 ? undefined : parts.join("");
}

function hasReportedOutputTokens(usage: unknown): boolean {
    return (
        typeof usage === "object" &&
        usage !== null &&
        "output_tokens" in usage &&
        typeof usage.output_tokens === "number"
    );
}

/**
 * Settles every server call against the terminal response, as ordinary tool calls already are.
 *
 * A server call completes inside the response that started it, so anything unsettled here only
 * means its own streamed events never arrived. The terminal payload is the authority when both
 * exist: a call whose arguments finished only there would otherwise be reported empty, and one
 * that never streamed at all would go unreported even though the provider ran it. The end is the
 * durable half of the pair, so losing it strands a live row and erases the record of the search.
 */
function* settleServerToolCalls(
    activeItems: Map<number, ActiveOutputItem>,
    terminalOutput: readonly unknown[],
    finished: Set<string>,
    options: { serverToolNames?: ReadonlySet<string> | undefined },
    fallbackCallIdScope: string,
    incomplete = false,
): Generator<SessionEvent> {
    for (const [outputIndex, activeItem] of activeItems) {
        if (
            activeItem.type !== "server_tool_call" ||
            activeItem.callId === undefined ||
            activeItem.name === undefined
        ) {
            continue;
        }
        const callId = activeItem.callId;
        const terminal = terminalOutput.find(
            (item, terminalIndex) =>
                serverExecutedItemName(item, options) !== undefined &&
                serverToolCallId(item, terminalIndex, fallbackCallIdScope) === callId,
        );
        const settled =
            terminal === undefined
                ? undefined
                : emptyToUndefined(serverToolCallArguments(terminal));
        const callIncomplete =
            terminal === undefined
                ? incomplete
                : isIncompleteServerToolCall(terminal) ||
                  (incomplete && isIncompleteOutputItem(terminal));
        yield {
            type: "toolcall_end",
            callId,
            arguments: settled ?? activeItem.argumentsJson ?? "",
            ...(callIncomplete ? { incomplete: true as const } : {}),
        };
        const result = terminal === undefined ? undefined : serverToolCallResult(terminal);
        if (result !== undefined) {
            yield* emitToolCallResult(callId, result, {
                ...(callIncomplete ? { incomplete: true } : {}),
            });
        }
        finished.add(callId);
        activeItems.delete(outputIndex);
    }

    for (const [terminalIndex, item] of terminalOutput.entries()) {
        const name = serverExecutedItemName(item, options);
        if (name === undefined) continue;
        const callId = serverToolCallId(item, terminalIndex, fallbackCallIdScope);
        if (finished.has(callId)) continue;
        const callIncomplete =
            isIncompleteServerToolCall(item) || (incomplete && isIncompleteOutputItem(item));
        yield { type: "toolcall_start", callId, name, server: true };
        yield {
            type: "toolcall_end",
            callId,
            arguments: serverToolCallArguments(item),
            ...(callIncomplete ? { incomplete: true as const } : {}),
        };
        const result = serverToolCallResult(item);
        if (result !== undefined) {
            yield* emitToolCallResult(callId, result, {
                ...(callIncomplete ? { incomplete: true } : {}),
            });
        }
        finished.add(callId);
    }
}

function emptyToUndefined(value: string): string | undefined {
    return value.length === 0 ? undefined : value;
}

/**
 * Names the server tool behind an output item the provider executed itself.
 *
 * Two shapes reach us, and each has to be positively recognized. A server search with its own
 * item type is unambiguous. Grok's X search instead reports its backend sub-calls as ordinary
 * custom tool calls, which look exactly like a call the client must answer, so classification
 * rests on two facts that are true only of a server call: the request asked for server tools at
 * all — nothing runs upstream that was never enabled, which also keeps compaction, which sends
 * none, entirely out of this path — and the provider marked the call with its reserved call-id
 * prefix.
 *
 * Nothing else qualifies. A name simply missing from the client's tools is not evidence of
 * anything: a model that invents a tool name is making a mistake it needs to hear about, and
 * silently reporting the invention as work the provider already did would leave the model waiting
 * for an answer to a call Rig deliberately never executes.
 */
function serverExecutedItemName(
    item: unknown,
    options: { serverToolNames?: ReadonlySet<string> | undefined },
): string | undefined {
    const parsed = asOutputItem(item);
    if (parsed === undefined) return undefined;
    const { type, name, call_id } = parsed;
    if (type === "web_search_call") {
        return options.serverToolNames?.has("web_search") === true ? "web_search" : undefined;
    }
    if (type !== "custom_tool_call" || name === undefined) return undefined;
    return options.serverToolNames?.has("x_search") === true &&
        call_id?.startsWith(HOSTED_SEARCH_CALL_PREFIX) === true
        ? name
        : undefined;
}

/**
 * Identifies a server call. Grok's X search carries a `call_id` and its web search only an `id`;
 * the output index stands in for anything that reports neither, so two concurrent calls can never
 * collide under one empty identifier.
 */
function serverToolCallId(item: unknown, outputIndex: number, fallbackCallIdScope: string): string {
    const parsed = asOutputItem(item);
    return (
        parsed?.call_id ??
        parsed?.id ??
        `server_tool_call_${fallbackCallIdScope}_${String(outputIndex)}`
    );
}

function serverToolCallArguments(item: unknown): string {
    const parsed = asOutputItem(item);
    if (parsed?.input !== undefined) return parsed.input;
    return parsed?.action === undefined ? "" : JSON.stringify(parsed.action);
}

/**
 * The provider-owned outcome of a server call, when the item carries one.
 *
 * Web search puts the pages it opened on `action.sources`. That is result material, not the
 * query the model asked for, so it is reported through the result events rather than only buried
 * in the call arguments. Calls with no such payload (X search today) return nothing here.
 */
function serverToolCallResult(item: unknown): string | undefined {
    const parsed = asOutputItem(item);
    if (parsed?.type !== "web_search_call" || parsed.action === undefined) return undefined;
    if (typeof parsed.action !== "object" || parsed.action === null) return undefined;
    if (!("sources" in parsed.action)) return undefined;
    const sources = (parsed.action as { sources?: unknown }).sources;
    if (!Array.isArray(sources) || sources.length === 0) return undefined;
    return JSON.stringify(sources);
}

function messageText(item: {
    content: readonly (
        | { type: "output_text"; text: string }
        | { type: "refusal"; refusal: string }
    )[];
}): string {
    return item.content
        .map((part) => (part.type === "output_text" ? part.text : part.refusal))
        .join("");
}

function missingTerminalText(streamedText: string | undefined, finalText: string): string {
    if (streamedText === undefined || streamedText.length === 0) return finalText;
    return finalText.startsWith(streamedText) ? finalText.slice(streamedText.length) : "";
}

function* settleTerminalReasoningBlocks(
    activeItems: Map<number, ActiveOutputItem>,
    terminalOutput: readonly unknown[],
    finishedReasoningItems: Set<number>,
): Generator<SessionEvent> {
    for (const [outputIndex, item] of terminalOutput.entries()) {
        if (finishedReasoningItems.has(outputIndex) || !isItemType(item, "reasoning")) continue;
        const active = activeItems.get(outputIndex);
        if (active?.type !== "reasoning") yield { type: "reasoning_start" };
        const finalText = reasoningText(item);
        const missingText = missingTerminalText(active?.streamedText, finalText ?? "");
        if (missingText.length > 0) yield { type: "reasoning_delta", delta: missingText };
        yield { type: "reasoning_end", reasoning: JSON.stringify(item) };
        finishedReasoningItems.add(outputIndex);
        activeItems.delete(outputIndex);
    }
}

function* settleTerminalMessageText(
    activeItems: Map<number, ActiveOutputItem>,
    terminalOutput: readonly unknown[],
    stripCitations: (text: string) => string,
    finishedMessageItems: Set<number>,
    append: (delta: string) => void,
): Generator<SessionEvent> {
    for (const [outputIndex, item] of terminalOutput.entries()) {
        if (finishedMessageItems.has(outputIndex)) continue;
        if (
            typeof item !== "object" ||
            item === null ||
            !("type" in item) ||
            item.type !== "message" ||
            !("content" in item) ||
            !Array.isArray(item.content)
        ) {
            continue;
        }
        const content = item.content;
        if (
            !content.every(
                (part) =>
                    typeof part === "object" &&
                    part !== null &&
                    (("type" in part &&
                        part.type === "output_text" &&
                        "text" in part &&
                        typeof part.text === "string") ||
                        ("type" in part &&
                            part.type === "refusal" &&
                            "refusal" in part &&
                            typeof part.refusal === "string")),
            )
        ) {
            continue;
        }
        const finalText = stripCitations(messageText({ content } as never));
        const active = activeItems.get(outputIndex);
        if (active?.type !== "message") yield { type: "text_start" };
        const missingText = missingTerminalText(active?.streamedText, finalText);
        if (missingText.length > 0) {
            append(missingText);
            yield { type: "text_delta", delta: missingText };
        }
        yield { type: "text_end" };
        finishedMessageItems.add(outputIndex);
        activeItems.delete(outputIndex);
    }
}

function* closeRemainingResponseContentBlocks(
    activeItems: Map<number, ActiveOutputItem>,
): Generator<SessionEvent> {
    for (const [outputIndex, item] of activeItems) {
        if (item.type === "message") {
            yield { type: "text_end" };
            activeItems.delete(outputIndex);
        } else if (item.type === "reasoning") {
            yield { type: "reasoning_end" };
            activeItems.delete(outputIndex);
        }
    }
}

function* settleTerminalClientToolCalls(
    terminalOutput: readonly unknown[],
    toolCalls: CollectedToolCall[],
    vendor: "codex" | "grok" | "responses" | undefined,
    incomplete: boolean,
    serverToolNames: ReadonlySet<string> | undefined,
): Generator<SessionEvent, boolean> {
    let found = false;
    for (const item of terminalOutput) {
        if (
            typeof item !== "object" ||
            item === null ||
            !("type" in item) ||
            (item.type !== "function_call" &&
                item.type !== "custom_tool_call" &&
                item.type !== "tool_search_call")
        ) {
            continue;
        }
        if (serverExecutedItemName(item, { serverToolNames }) !== undefined) continue;
        if (
            !("call_id" in item) ||
            typeof item.call_id !== "string" ||
            toolCalls.some((call) => call.callId === item.call_id)
        ) {
            continue;
        }
        if (item.type === "tool_search_call") {
            if (!("execution" in item) || item.execution !== "client" || !("arguments" in item)) {
                continue;
            }
            const argumentsJson = JSON.stringify(item.arguments);
            yield {
                type: "toolcall_start",
                callId: item.call_id,
                name: "tool_search",
                vendor: responseToolVendor(vendor, "tool_search_call"),
            };
            yield { type: "toolcall_delta", callId: item.call_id, delta: argumentsJson };
            yield {
                type: "toolcall_end",
                callId: item.call_id,
                arguments: argumentsJson,
                ...(incomplete ? { incomplete: true } : {}),
            };
            toolCalls.push({
                callId: item.call_id,
                name: "tool_search",
                arguments: argumentsJson,
                ...(incomplete ? { incomplete: true } : {}),
                vendor: responseToolVendor(vendor, "tool_search_call"),
            });
            found = true;
            continue;
        }
        assertValidToolCallItem(item);
        const name = "name" in item && typeof item.name === "string" ? item.name : undefined;
        if (name === undefined) continue;
        const namespace =
            "namespace" in item && typeof item.namespace === "string" ? item.namespace : undefined;
        const argumentsJson =
            item.type === "function_call"
                ? "arguments" in item && typeof item.arguments === "string"
                    ? item.arguments
                    : ""
                : "input" in item && typeof item.input === "string"
                  ? item.input
                  : "";
        const type = item.type;
        yield {
            type: "toolcall_start",
            callId: item.call_id,
            name,
            ...(namespace === undefined ? {} : { namespace }),
            vendor: responseToolVendor(vendor, type),
        };
        if (argumentsJson.length > 0) {
            yield { type: "toolcall_delta", callId: item.call_id, delta: argumentsJson };
        }
        yield {
            type: "toolcall_end",
            callId: item.call_id,
            arguments: argumentsJson,
            ...(incomplete ? { incomplete: true } : {}),
        };
        toolCalls.push({
            callId: item.call_id,
            name,
            ...(namespace === undefined ? {} : { namespace }),
            arguments: argumentsJson,
            ...(incomplete ? { incomplete: true } : {}),
            vendor: responseToolVendor(vendor, type),
        });
        found = true;
    }
    return found;
}

/**
 * The few fields a server call carries, across the item shapes that can hold one. Every item
 * carries more than this; only these decide whether the provider ran the call itself.
 */
const outputItemSchema = Type.Object(
    {
        type: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        id: Type.Optional(Type.String()),
        call_id: Type.Optional(Type.String()),
        input: Type.Optional(Type.String()),
        action: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);
type OutputItem = Static<typeof outputItemSchema>;

const clientToolCallItemSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("function_call"),
            call_id: Type.String(),
            name: Type.String(),
            arguments: Type.String(),
            namespace: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
    ),
    Type.Object(
        {
            type: Type.Literal("custom_tool_call"),
            call_id: Type.String(),
            name: Type.String(),
            input: Type.String(),
            namespace: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
    ),
]);

const serverWebSearchCallItemSchema = Type.Object(
    {
        type: Type.Literal("web_search_call"),
        id: Type.Optional(Type.String()),
        action: Type.Union([
            Type.Object(
                {
                    type: Type.Literal("search"),
                    queries: Type.Optional(Type.Array(Type.String())),
                    query: Type.Optional(Type.String()),
                    sources: Type.Optional(
                        Type.Array(
                            Type.Object(
                                { type: Type.Literal("url"), url: Type.String() },
                                { additionalProperties: true },
                            ),
                        ),
                    ),
                },
                { additionalProperties: true },
            ),
            Type.Object(
                {
                    type: Type.Literal("open_page"),
                    url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                },
                { additionalProperties: true },
            ),
            Type.Object(
                {
                    type: Type.Literal("find_in_page"),
                    pattern: Type.String(),
                    url: Type.String(),
                },
                { additionalProperties: true },
            ),
        ]),
        status: Type.Optional(
            Type.Union([
                Type.Literal("in_progress"),
                Type.Literal("searching"),
                Type.Literal("completed"),
                Type.Literal("failed"),
            ]),
        ),
    },
    { additionalProperties: true },
);

const partialServerWebSearchCallItemSchema = Type.Object(
    {
        ...serverWebSearchCallItemSchema.properties,
        action: Type.Optional(serverWebSearchCallItemSchema.properties.action),
    },
    { additionalProperties: true },
);

function assertValidToolCallItem(
    item: unknown,
    options: { allowMissingServerAction?: boolean } = {},
): void {
    if (
        typeof item !== "object" ||
        item === null ||
        !("type" in item) ||
        (item.type !== "function_call" &&
            item.type !== "custom_tool_call" &&
            item.type !== "web_search_call")
    ) {
        return;
    }
    if (item.type === "web_search_call") {
        const schema =
            options.allowMissingServerAction === true
                ? partialServerWebSearchCallItemSchema
                : serverWebSearchCallItemSchema;
        if (!Value.Check(schema, item)) {
            throw new Error("Provider returned a malformed web_search_call output item.");
        }
        return;
    }
    if (!Value.Check(clientToolCallItemSchema, item)) {
        throw new Error(`Provider returned a malformed ${String(item.type)} output item.`);
    }
}

function assertServerCallWasDeclared(
    item: unknown,
    options: { serverToolNames?: ReadonlySet<string> | undefined },
): void {
    const parsed = asOutputItem(item);
    if (parsed?.type === "web_search_call" && options.serverToolNames?.has("web_search") !== true) {
        throw new Error("Provider returned web_search_call without a declared server tool.");
    }
    if (
        parsed?.type === "custom_tool_call" &&
        parsed.call_id?.startsWith(HOSTED_SEARCH_CALL_PREFIX) === true &&
        options.serverToolNames?.has("x_search") !== true
    ) {
        throw new Error("Provider returned an X server call without a declared server tool.");
    }
}

/**
 * Reads the deciding fields off an output item, or nothing when the item does not carry them as
 * the protocol describes.
 *
 * Casting the payload instead would let a mistyped field travel as a name or an identifier the
 * rest of this file believes is a string, and those reach the durable session log. An item this
 * refuses is simply one nothing here can classify, which every caller already treats as a call
 * the client owes an answer for — a visibly stalled tool rather than a run that quietly finishes
 * while the model waits.
 */
function asOutputItem(item: unknown): OutputItem | undefined {
    return Value.Check(outputItemSchema, item) ? item : undefined;
}

function responseToolVendor(
    vendor: "codex" | "grok" | "responses" | undefined,
    type: ResponsesToolCallType,
): ResponsesToolVendor {
    const provider = vendor ?? "grok";
    return type === "tool_search_call"
        ? { provider, type, execution: "client" }
        : { provider, type };
}

function isIncompleteOutputItem(item: unknown): boolean {
    return (
        typeof item === "object" &&
        item !== null &&
        "status" in item &&
        item.status === "incomplete"
    );
}

function isIncompleteServerToolCall(item: unknown): boolean {
    return (
        typeof item === "object" &&
        item !== null &&
        "status" in item &&
        typeof item.status === "string" &&
        item.status !== "completed"
    );
}
