import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses.js";

import type {
    SessionAssistantBlock,
    SessionContext,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { createCodexCallIdMapper } from "@/protocol/responses/createCodexCallIdMapper.js";
import {
    toOpenAIInputContent,
    toOpenAIInputContentBlocks,
} from "@/protocol/responses/toOpenAIInputContent.js";
import type { ResponsesToolCallType } from "@/protocol/responses/ResponsesToolVendor.js";

export function toOpenAIResponseInput(context: SessionContext): ResponseInput {
    const input: ResponseInput = [];
    const customToolCallIds = new Set<string>();
    const toolSearchCallIds = new Set<string>();
    const mapCallId = createCodexCallIdMapper();
    let messageId = 0;

    for (const original of context.messages) {
        // A message from another agent is a developer notification naming its author, the same
        // one every other provider receives; Responses is given no native agent item.
        const message =
            original.role === "agent" ? toSessionAgentNotificationMessage(original) : original;
        if (message.role === "system") {
            input.push({
                type: "message",
                role: "developer",
                content: toOpenAIInputContentBlocks(message.content),
            });
            continue;
        }
        if (message.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: toOpenAIInputContent(message.content),
            });
            continue;
        }
        if (message.role === "compaction") {
            if (message.encryptedContent === null) {
                throw new Error("Responses compaction is missing encrypted content.");
            }
            input.push({ type: "compaction", encrypted_content: message.encryptedContent });
            continue;
        }
        if (message.role === "tool") {
            const callId = mapCallId(message.callId);
            if (toolSearchCallIds.has(callId)) {
                try {
                    const parsed: unknown = JSON.parse(textFromBlocks(message.content));
                    input.push({
                        type: "tool_search_output",
                        call_id: callId,
                        execution: "client",
                        status: "completed",
                        tools:
                            typeof parsed === "object" &&
                            parsed !== null &&
                            "tools" in parsed &&
                            Array.isArray(parsed.tools)
                                ? parsed.tools
                                : parsed,
                    } as ResponseInputItem);
                } catch {
                    // Malformed tool-search output is omitted from replay.
                }
                continue;
            }
            input.push({
                type:
                    customToolCallIds.has(callId) ||
                    toolVendorType(message.vendor) === "custom_tool_call"
                        ? "custom_tool_call_output"
                        : "function_call_output",
                call_id: callId,
                output: toOpenAIInputContent(message.content),
            } as ResponseInputItem);
            continue;
        }

        for (const block of message.content) {
            const native = nativeOutputItem(block);
            if (native !== undefined) {
                const callId =
                    block.type === "tool_call" || block.type === "tool_result"
                        ? block.callId
                        : undefined;
                input.push(
                    callId === undefined ? native : withNativeCallId(native, mapCallId(callId)),
                );
                continue;
            }
            if (block.type === "reasoning") {
                if (block.reasoning === undefined) continue;
                try {
                    const item = JSON.parse(block.reasoning) as ResponseInputItem;
                    if (item.type === "reasoning") input.push(item);
                } catch {
                    // Invalid optional reasoning state does not break the conversation.
                }
                continue;
            }
            if (block.type === "text") {
                input.push({
                    type: "message",
                    id: `msg_rig_${messageId++}`,
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: block.text, annotations: [] }],
                } as ResponseInputItem);
                continue;
            }
            if (block.type === "tool_result") continue;

            const callId = mapCallId(block.callId);
            const vendorType = toolVendorType(block.vendor);
            if (isServerToolSearchCall(block.vendor, block.server)) {
                try {
                    input.push({
                        type: "tool_search_call",
                        call_id: callId,
                        execution: "server",
                        arguments: JSON.parse(block.arguments),
                    } as ResponseInputItem);
                } catch {
                    // Malformed optional server tool-search arguments are omitted from replay.
                }
            } else if (vendorType === "tool_search_call") {
                try {
                    input.push({
                        type: "tool_search_call",
                        call_id: callId,
                        execution: "client",
                        arguments: JSON.parse(block.arguments),
                    } as ResponseInputItem);
                    toolSearchCallIds.add(callId);
                } catch {
                    // Malformed tool-search arguments are omitted from replay.
                }
            } else if (vendorType === "custom_tool_call") {
                input.push({
                    type: "custom_tool_call",
                    call_id: callId,
                    name: block.name,
                    ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
                    input: block.arguments,
                } as ResponseInputItem);
                customToolCallIds.add(callId);
            } else {
                input.push({
                    type: "function_call",
                    call_id: callId,
                    name: block.name,
                    ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
                    arguments: block.arguments,
                } as ResponseInputItem);
            }
        }
    }
    return input;
}

function textFromBlocks(blocks: readonly SessionOutputBlock[]): string {
    return blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function nativeOutputItem(block: SessionAssistantBlock): ResponseInputItem | undefined {
    if (
        (block.type !== "tool_call" && block.type !== "tool_result") ||
        block.vendor === undefined
    ) {
        return undefined;
    }
    const vendor = block.vendor;
    if (typeof vendor !== "object" || vendor === null || !("outputItem" in vendor))
        return undefined;
    const encoded = vendor.outputItem;
    if (typeof encoded !== "string") return undefined;
    try {
        return JSON.parse(encoded) as ResponseInputItem;
    } catch {
        return undefined;
    }
}

function withNativeCallId(item: ResponseInputItem, callId: string): ResponseInputItem {
    return "call_id" in item && typeof item.call_id === "string"
        ? ({ ...item, call_id: callId } as ResponseInputItem)
        : item;
}

function toolVendorType(vendor: any): ResponsesToolCallType | undefined {
    if (vendor?.provider !== "codex" && vendor?.provider !== "responses") return undefined;
    return vendor?.type === "function_call" ||
        vendor?.type === "custom_tool_call" ||
        vendor?.type === "tool_search_call"
        ? vendor.type
        : undefined;
}

function isServerToolSearchCall(vendor: any, server: true | undefined): boolean {
    return (
        server === true &&
        (vendor?.provider === "codex" || vendor?.provider === "responses") &&
        vendor?.type === "server_tool_call" &&
        vendor?.nativeType === "tool_search_call"
    );
}
