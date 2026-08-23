import { createHash } from "node:crypto";

import type {
    Options as ClaudeSdkOptions,
    SDKUserMessage,
    SessionStore,
    SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import type {
    SessionAgentMessage,
    SessionAssistantMessage,
    SessionContext,
    SessionImageBlock,
    SessionInputBlock,
    SessionMessage,
    SessionReasoningBlock,
    SessionSystemMessage,
    SessionTextBlock,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@/core/SessionContext.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { toSessionReminderMessage } from "@/core/toSessionReminderMessage.js";
import { createProviderToolCallIdResolver, providerToolCallId } from "@/core/SessionToolCallId.js";

/** A message Claude can replay, once system notices have been projected onto the user role. */
type ReplayMessage = Exclude<SessionMessage, SessionSystemMessage | SessionAgentMessage>;

export interface ClaudeSessionReplay {
    compactionSummary(): string | undefined;
    entries(): readonly SessionStoreEntry[];
    message: SDKUserMessage;
    options: Pick<ClaudeSdkOptions, "persistSession" | "resume" | "sessionStore">;
    prompt: AsyncIterable<SDKUserMessage>;
}

export function createClaudeSessionReplay(options: {
    context: SessionContext;
    model: string;
    sessionId: string;
}): ClaudeSessionReplay {
    const messages = toReplayMessages(options.context.messages);
    const resolveProviderCallId = createProviderToolCallIdResolver(options.context.messages);
    const splitIndex = findPromptStart(messages);
    const history = messages.slice(0, splitIndex);
    const promptMessages = messages.slice(splitIndex);
    const entries = toSessionStoreEntries(history, options, resolveProviderCallId);
    let compactionSummary: string | undefined;
    const sessionStore: SessionStore = {
        append: (key, appendedEntries) => {
            // Rig owns the conversation. Ignore Claude's transcript mirror instead of making a
            // second history authoritative. Native compaction is the one exception in what we
            // observe: its replacement summary is a result, not resumable session state.
            if (key.sessionId === options.sessionId) {
                compactionSummary = findCompactionSummary(appendedEntries) ?? compactionSummary;
            }
            return Promise.resolve();
        },
        load: (key) =>
            Promise.resolve(
                key.sessionId === options.sessionId && key.subpath === undefined ? entries : null,
            ),
    };
    const message = toPromptMessage(promptMessages, resolveProviderCallId);
    return {
        compactionSummary: () => compactionSummary,
        entries: () => entries,
        message,
        options: { persistSession: true, resume: options.sessionId, sessionStore },
        prompt: singleMessagePrompt(message),
    };
}

export function createClaudeLivePromptMessage(
    sessionMessages: readonly SessionMessage[],
): SDKUserMessage {
    const messages = toReplayMessages(sessionMessages);
    const resolveProviderCallId = createProviderToolCallIdResolver(sessionMessages);
    let firstTrailingToolIndex = messages.length;
    while (firstTrailingToolIndex > 0 && messages[firstTrailingToolIndex - 1]?.role === "tool") {
        firstTrailingToolIndex -= 1;
    }
    return toPromptMessage(
        firstTrailingToolIndex === messages.length
            ? messages.slice(-1)
            : messages.slice(firstTrailingToolIndex),
        resolveProviderCallId,
    );
}

/**
 * Anthropic has no system role inside a conversation, so a session system message becomes a
 * `<system-reminder>` user turn in the position the caller placed it. A message from another
 * agent takes the same route, as the notification that names who sent it.
 */
function toReplayMessages(messages: readonly SessionMessage[]): ReplayMessage[] {
    return messages.map((message) => {
        if (message.role === "agent") {
            return toSessionReminderMessage(toSessionAgentNotificationMessage(message));
        }
        return message.role === "system" ? toSessionReminderMessage(message) : message;
    });
}

function findPromptStart(messages: readonly ReplayMessage[]): number {
    const lastIndex = Math.max(0, messages.length - 1);
    if (messages[lastIndex]?.role !== "tool") return lastIndex;
    return messages.length;
}

function toPromptMessage(
    messages: readonly ReplayMessage[],
    resolveProviderCallId: (callId: string) => string,
): SDKUserMessage {
    const first = messages[0];
    if (first === undefined) {
        return toSdkUserMessage({
            role: "user",
            content: [{ type: "text", text: "Continue from the supplied tool result." }],
        });
    }
    if (first.role === "user") return toSdkUserMessage(first);
    if (first.role !== "tool") {
        throw new Error("Claude inference must start from a user or tool-result message.");
    }
    return {
        type: "user",
        parent_tool_use_id: null,
        message: {
            role: "user",
            content: messages.map((message) => {
                if (message.role !== "tool") {
                    throw new Error("A Claude tool-result prompt may contain only tool results.");
                }
                return toToolResultBlock(message, resolveProviderCallId);
            }),
        },
    };
}

function toSessionStoreEntries(
    messages: readonly ReplayMessage[],
    options: { model: string; sessionId: string },
    resolveProviderCallId: (callId: string) => string,
): SessionStoreEntry[] {
    let parentUuid: string | null = null;
    const assistantUuidByToolCallId = new Map<string, string>();
    const entries: SessionStoreEntry[] = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined) continue;
        const uuid = stableMessageUuid(options.sessionId, message, index);
        const base = {
            // Rig runs every tool itself, so Claude Code never works from a caller-owned
            // directory. The transcript still needs the field expected by its resume path.
            cwd: process.cwd(),
            entrypoint: "sdk-ts",
            isSidechain: false,
            parentUuid,
            sessionId: options.sessionId,
            timestamp: new Date(index).toISOString(),
            userType: "external",
            uuid,
            version: "happy-providers",
        };
        if (message.role === "assistant") {
            const sdkMessage = toSdkAssistantMessage(message, options.model, uuid);
            // This must match Claude Code's transcript shape exactly. Streaming persists one
            // assistant entry per content block, each with its own transcript UUID but with the
            // same API message.id. Resume first reconstructs the parentUuid chain, then
            // normalizeMessagesForAPI merges adjacent assistant entries by that shared message.id.
            // Combining the blocks into one synthetic entry, changing the id between siblings, or
            // failing to link every sibling can make resume discard an orphaned thinking block or
            // lose one branch of a parallel tool-use turn.
            for (const [blockIndex, block] of sdkMessage.content.entries()) {
                const blockUuid =
                    blockIndex === 0
                        ? uuid
                        : stableContentBlockUuid(options.sessionId, index, blockIndex);
                entries.push({
                    ...base,
                    parentUuid: blockIndex === 0 ? base.parentUuid : parentUuid,
                    uuid: blockUuid,
                    message: { ...sdkMessage, content: [block] },
                    type: "assistant",
                });
                parentUuid = blockUuid;
                if (typeof block === "object" && block !== null && block.type === "tool_use") {
                    assistantUuidByToolCallId.set(block.id, blockUuid);
                }
            }
            continue;
        }
        if (message.role === "tool") {
            const toolResults = [message];
            while (messages[index + 1]?.role === "tool") {
                toolResults.push(messages[index + 1] as SessionToolResultMessage);
                index += 1;
            }
            const sourceToolAssistantUUID = assistantUuidByToolCallId.get(
                resolveProviderCallId(message.callId),
            );
            entries.push({
                ...base,
                isMeta: true,
                message: {
                    role: "user",
                    content: toolResults.map((result) =>
                        toToolResultBlock(result, resolveProviderCallId),
                    ),
                },
                ...(sourceToolAssistantUUID === undefined ? {} : { sourceToolAssistantUUID }),
                type: "user",
            });
            parentUuid = uuid;
            continue;
        }
        if (message.role === "compaction" && message.content === null) continue;
        const content: readonly SessionInputBlock[] =
            message.role === "compaction"
                ? [{ type: "text", text: message.content! }]
                : message.content;
        entries.push({
            ...base,
            message: {
                role: "user",
                content: toSdkContent(content),
            },
            type: "user",
        });
        parentUuid = uuid;
    }
    return entries;
}

function toSdkUserMessage(message: SessionUserMessage): SDKUserMessage {
    return {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: toSdkContent(message.content) },
    };
}

function toSdkAssistantMessage(message: SessionAssistantMessage, model: string, uuid: string) {
    return {
        id: `msg_rig_${uuid.replaceAll("-", "")}`,
        container: null,
        content: message.content.flatMap((block): any[] => {
            if (block.type === "reasoning") return toThinkingBlock(block);
            if (block.type === "text") return [{ type: "text" as const, text: block.text }];
            if (block.type === "tool_result") return [];
            return [
                {
                    type: "tool_use" as const,
                    id: providerToolCallId(block),
                    name: block.name,
                    input: parseArguments(block.arguments),
                },
            ];
        }),
        model,
        role: "assistant" as const,
        stop_details: null,
        stop_reason: message.content.some((block) => block.type === "tool_call")
            ? ("tool_use" as const)
            : ("end_turn" as const),
        stop_sequence: null,
        type: "message" as const,
        usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            server_tool_use: null,
            service_tier: null,
            cache_creation: null,
        },
    };
}

function toThinkingBlock(
    reasoning: SessionReasoningBlock,
): (
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
)[] {
    if (reasoning.reasoning === undefined) return [];
    if (reasoning.text === undefined) {
        return [{ type: "redacted_thinking" as const, data: reasoning.reasoning }];
    }
    return [
        {
            type: "thinking" as const,
            thinking: reasoning.text,
            signature: reasoning.reasoning,
        },
    ];
}

function toToolResultBlock(
    message: SessionToolResultMessage,
    resolveProviderCallId: (callId: string) => string,
) {
    return {
        type: "tool_result" as const,
        tool_use_id: resolveProviderCallId(message.callId),
        content: toSdkContent(message.content),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
    };
}

function toSdkContent(content: readonly SessionInputBlock[]) {
    if (content.length === 1 && content[0]?.type === "text") return content[0].text;
    return content.map(toContentBlock);
}

function toContentBlock(block: SessionTextBlock | SessionImageBlock) {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    return {
        type: "image" as const,
        source: {
            type: "base64" as const,
            media_type: block.mimeType as ClaudeImageMediaType,
            data: block.data,
        },
    };
}

type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

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

function stableMessageUuid(sessionId: string, message: SessionMessage, index: number): string {
    return stableUuid(sessionId, `${index}:${message.role}`);
}

function stableContentBlockUuid(
    sessionId: string,
    messageIndex: number,
    blockIndex: number,
): string {
    return stableUuid(sessionId, `${messageIndex}:assistant:${blockIndex}`);
}

function stableUuid(sessionId: string, identity: string): string {
    const digest = createHash("sha256").update(sessionId).update(identity).digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function findCompactionSummary(entries: readonly SessionStoreEntry[]): string | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.isCompactSummary !== true) continue;
        const message = entry.message as { content?: unknown } | undefined;
        if (typeof message?.content === "string" && message.content.trim().length > 0) {
            return message.content;
        }
    }
    return undefined;
}

async function* singleMessagePrompt(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
    yield message;
}
