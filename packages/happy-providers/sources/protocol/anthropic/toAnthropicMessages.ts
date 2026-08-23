import type {
    BetaContentBlockParam,
    BetaImageBlockParam,
    BetaMessageParam,
    BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type {
    SessionAssistantBlock,
    SessionAssistantMessage,
    SessionImageBlock,
    SessionInputBlock,
    SessionMessage,
    SessionOutputBlock,
    SessionTextBlock,
    SessionToolResultMessage,
} from "@/core/SessionContext.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { toSessionReminderMessage } from "@/core/toSessionReminderMessage.js";
import { toAnthropicCompactionBlock } from "@/protocol/anthropic/toAnthropicCompactionBlock.js";
import { toAnthropicToolName } from "@/protocol/anthropic/toAnthropicToolName.js";

export type AnthropicReasoningState =
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string };

export function toAnthropicMessages(messages: readonly SessionMessage[]): BetaMessageParam[] {
    const converted = messages.flatMap((message): BetaMessageParam[] => {
        if (message.role === "system" || message.role === "agent") {
            // Anthropic has no system role inside a conversation, so a notice keeps the position
            // the caller chose as a `<system-reminder>` user turn. A message from another agent
            // arrives the same way, as the notification that names who sent it.
            const notice =
                message.role === "agent" ? toSessionAgentNotificationMessage(message) : message;
            const reminder = toSessionReminderMessage(notice);
            return [{ role: "user", content: toInputContent(reminder.content) }];
        }
        if (message.role === "compaction") {
            return [{ role: "assistant", content: [toAnthropicCompactionBlock(message)] }];
        }
        if (message.role === "user") {
            return [{ role: "user", content: toInputContent(message.content) }];
        }
        if (message.role === "tool") {
            return [{ role: "user", content: [toToolResult(message)] }];
        }
        return [{ role: "assistant", content: toAssistantContent(message) }];
    });
    const last = converted.at(-1);
    if (last !== undefined) last.content = addCacheBreakpoint(last.content);
    return converted;
}

export function encodeAnthropicReasoning(state: AnthropicReasoningState): string {
    return JSON.stringify({ provider: "anthropic", ...state });
}

export function encodeAnthropicReasoningBlocks(blocks: readonly AnthropicReasoningState[]): string {
    return JSON.stringify({ provider: "anthropic", blocks });
}

function toInputContent(content: readonly SessionInputBlock[]): string | BetaContentBlockParam[] {
    if (content.length === 1 && content[0]?.type === "text") return content[0].text;
    return content.map(toInputBlock);
}

function toInputBlock(block: SessionInputBlock): BetaContentBlockParam {
    if (block.type === "text") return { type: "text", text: block.text };
    return {
        type: "image",
        source: {
            type: "base64",
            media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: block.data,
        },
    };
}

function toAssistantContent(message: SessionAssistantMessage): BetaContentBlockParam[] {
    return message.content.flatMap(toAssistantBlock);
}

function toAssistantBlock(block: SessionAssistantBlock): BetaContentBlockParam[] {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "reasoning") {
        if (block.reasoning === undefined) return [];
        return block.text === undefined
            ? [{ type: "redacted_thinking", data: block.reasoning }]
            : [{ type: "thinking", thinking: block.text, signature: block.reasoning }];
    }
    if (block.type === "tool_result") {
        const outputBlock = parseOutputBlock(block.vendor);
        if (outputBlock !== undefined) return [withAnthropicToolUseId(outputBlock, block.callId)];
        return [
            {
                type: "tool_result",
                tool_use_id: block.callId,
                content: block.content.map(toToolResultContentBlock),
                ...(block.isError === undefined ? {} : { is_error: block.isError }),
            },
        ];
    }
    return [
        {
            type: "tool_use",
            id: block.callId,
            name: toAnthropicToolName(block),
            input: parseArguments(block.arguments),
        },
    ];
}

function parseOutputBlock(vendor: unknown): BetaContentBlockParam | undefined {
    if (typeof vendor !== "object" || vendor === null || !("outputBlock" in vendor)) {
        return undefined;
    }
    const encoded = vendor.outputBlock;
    if (typeof encoded !== "string") return undefined;
    try {
        return JSON.parse(encoded) as BetaContentBlockParam;
    } catch {
        return undefined;
    }
}

function toToolResult(message: SessionToolResultMessage): BetaContentBlockParam {
    return {
        type: "tool_result",
        tool_use_id: message.callId,
        content:
            message.content.length === 1 && message.content[0]?.type === "text"
                ? message.content[0].text
                : message.content.map(toToolResultContentBlock),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
    };
}

function withAnthropicToolUseId(
    block: BetaContentBlockParam,
    callId: string,
): BetaContentBlockParam {
    return "tool_use_id" in block ? { ...block, tool_use_id: callId } : block;
}

function toToolResultContentBlock(
    block: SessionOutputBlock,
): BetaTextBlockParam | BetaImageBlockParam {
    if (block.type === "text") return { type: "text", text: block.text };
    return {
        type: "image",
        source: {
            type: "base64",
            media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: block.data,
        },
    };
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(argumentsJson);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function addCacheBreakpoint(content: string | BetaContentBlockParam[]): BetaContentBlockParam[] {
    const blocks: BetaContentBlockParam[] =
        typeof content === "string" ? [{ type: "text", text: content }] : [...content];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block !== undefined) {
            const cached = withCacheBreakpoint(block);
            if (cached === undefined) continue;
            blocks[index] = cached;
            break;
        }
    }
    return blocks;
}

function withCacheBreakpoint(block: BetaContentBlockParam): BetaContentBlockParam | undefined {
    const cache_control = { type: "ephemeral" as const };
    if (block.type === "text") return { ...block, cache_control };
    if (block.type === "image") return { ...block, cache_control };
    if (block.type === "tool_result") return { ...block, cache_control };
    if (block.type === "tool_use") return { ...block, cache_control };
    return undefined;
}
