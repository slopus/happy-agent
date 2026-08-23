import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses.js";

import type {
    SessionAssistantBlock,
    SessionContext,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { toSessionReminderMessage } from "@/core/toSessionReminderMessage.js";
import { createProviderToolCallIdResolver, providerToolCallId } from "@/core/SessionToolCallId.js";
import type { GrokToolVendor } from "@/vendors/grok/GrokToolVendor.js";
import { toGrokInputContent } from "@/vendors/grok/impl/toGrokInputContent.js";

export function toGrokResponseInput(context: SessionContext): ResponseInput {
    const input: ResponseInput = [
        { type: "message", role: "system", content: context.instructions } as ResponseInputItem,
    ];
    const customToolCallIds = new Set<string>();
    const toolSearchCallIds = new Set<string>();
    const resolveProviderCallId = createProviderToolCallIdResolver(context.messages);
    for (const original of context.messages) {
        // xAI has no in-conversation system role, so a notice — including the one that carries a
        // message from another agent — reaches the model as a `<system-reminder>` user turn.
        const message =
            original.role === "agent" ? toSessionAgentNotificationMessage(original) : original;
        if (message.role === "system") {
            const reminder = toSessionReminderMessage(message);
            input.push({
                type: "message",
                role: "user",
                content: toGrokInputContent(reminder.content),
            } as ResponseInputItem);
            continue;
        }
        if (message.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: toGrokInputContent(message.content),
            });
            continue;
        }
        if (message.role === "compaction") continue;
        if (message.role === "tool") {
            const providerCallId = resolveProviderCallId(message.callId);
            if (toolSearchCallIds.has(providerCallId)) {
                input.push({
                    type: "tool_search_output",
                    call_id: providerCallId,
                    execution: "client",
                    status: "completed",
                    tools: parseToolSearchTools(message.content),
                } as ResponseInputItem);
                continue;
            }
            input.push({
                type:
                    customToolCallIds.has(providerCallId) ||
                    toolVendorType(message.vendor) === "custom_tool_call"
                        ? "custom_tool_call_output"
                        : "function_call_output",
                call_id: providerCallId,
                output: toGrokInputContent(message.content),
            } as ResponseInputItem);
            continue;
        }

        for (const block of message.content) {
            const native = nativeOutputItem(block);
            if (native !== undefined) {
                const providerCallId =
                    block.type === "tool_call"
                        ? providerToolCallId(block)
                        : block.type === "tool_result"
                          ? resolveProviderCallId(block.callId)
                          : undefined;
                const replay =
                    providerCallId === undefined
                        ? native
                        : withNativeCallId(native, providerCallId);
                input.push(replay);
                rememberNativeCall(replay, customToolCallIds, toolSearchCallIds);
                continue;
            }
            if (block.type === "reasoning") {
                if (block.reasoning === undefined) continue;
                try {
                    const item = JSON.parse(block.reasoning) as ResponseInputItem;
                    if (item.type === "reasoning") input.push(item);
                } catch {
                    // Optional replay state must not make the whole conversation unusable.
                }
                continue;
            }
            if (block.type === "text") {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: block.text,
                } as ResponseInputItem);
                continue;
            }
            if (block.type === "tool_result") continue;
            const providerCallId = providerToolCallId(block);
            const vendorType = toolVendorType(block.vendor);
            if (vendorType === "tool_search_call") {
                try {
                    input.push({
                        type: "tool_search_call",
                        call_id: providerCallId,
                        execution: "client",
                        arguments: JSON.parse(block.arguments),
                    } as ResponseInputItem);
                    toolSearchCallIds.add(providerCallId);
                } catch {
                    // Malformed optional tool-search state is omitted from replay.
                }
            } else if (vendorType === "custom_tool_call") {
                input.push({
                    type: "custom_tool_call",
                    call_id: providerCallId,
                    name: block.name,
                    input: block.arguments,
                } as ResponseInputItem);
                customToolCallIds.add(providerCallId);
            } else {
                input.push({
                    type: "function_call",
                    call_id: providerCallId,
                    name: block.name,
                    arguments: block.arguments,
                } as ResponseInputItem);
            }
        }
    }
    return input;
}

function withNativeCallId(item: ResponseInputItem, callId: string): ResponseInputItem {
    return "call_id" in item && typeof item.call_id === "string"
        ? ({ ...item, call_id: callId } as ResponseInputItem)
        : item;
}

function parseToolSearchTools(content: readonly SessionOutputBlock[]): readonly unknown[] {
    try {
        const parsed: unknown = JSON.parse(textFromBlocks(content));
        if (Array.isArray(parsed)) return parsed;
        return typeof parsed === "object" &&
            parsed !== null &&
            "tools" in parsed &&
            Array.isArray(parsed.tools)
            ? parsed.tools
            : [];
    } catch {
        return [];
    }
}

function textFromBlocks(content: readonly SessionOutputBlock[]): string {
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function nativeOutputItem(block: SessionAssistantBlock): ResponseInputItem | undefined {
    if ((block.type !== "tool_call" && block.type !== "tool_result") || block.vendor === undefined)
        return undefined;
    const vendor = block.vendor;
    if (
        typeof vendor !== "object" ||
        vendor === null ||
        !("outputItem" in vendor) ||
        typeof vendor.outputItem !== "string"
    )
        return undefined;
    try {
        return JSON.parse(vendor.outputItem) as ResponseInputItem;
    } catch {
        return undefined;
    }
}

function rememberNativeCall(
    item: ResponseInputItem,
    customToolCallIds: Set<string>,
    toolSearchCallIds: Set<string>,
): void {
    if (item.type === "custom_tool_call") customToolCallIds.add(item.call_id);
    if (item.type === "tool_search_call" && item.call_id != null) {
        toolSearchCallIds.add(item.call_id);
    }
}

function toolVendorType(vendor: any): GrokToolVendor["type"] | undefined {
    if (typeof vendor !== "object" || vendor === null || vendor.provider !== "grok")
        return undefined;
    return vendor.type === "function_call" ||
        vendor.type === "custom_tool_call" ||
        vendor.type === "tool_search_call"
        ? vendor.type
        : undefined;
}
