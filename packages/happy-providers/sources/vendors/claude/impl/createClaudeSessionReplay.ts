import { createHash } from "node:crypto";

import type {
    Options as ClaudeSdkOptions,
    SDKUserMessage,
    SessionStore,
    SessionStoreEntry,
    SessionMessage as NativeSessionMessage,
    SDKCompactBoundaryMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { deterministicStringify } from "@steve.kite/stdlib";

import type {
    SessionAgentMessage,
    SessionAssistantBlock,
    SessionAssistantMessage,
    SessionContext,
    SessionInputBlock,
    SessionMessage,
    SessionReasoningBlock,
    SessionSystemMessage,
    SessionToolResultMessage,
    SessionToolResultBlock,
    SessionUserMessage,
} from "@/core/SessionContext.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { toSessionReminderMessage } from "@/core/toSessionReminderMessage.js";
import { claudeSessionAttachments } from "@/vendors/claude/impl/claudeSessionAttachments.js";
import { CLAUDE_IMAGE_BASE64_LIMIT } from "@/vendors/claude/impl/fitClaudeImages.js";
import { claudeNativeCompactionContext } from "@/vendors/claudeAgent/impl/claudeNativeCompactionContext.js";
import {
    readClaudeNativeCompaction,
    ClaudeNativeCompactionPendingError,
} from "@/vendors/claudeAgent/impl/readClaudeNativeCompaction.js";
import type { AcpNativeCompaction } from "@/protocol/acp/AcpConnection.js";

/** A message Claude can replay, once system notices have been projected onto the user role. */
type ReplayMessage = Exclude<SessionMessage, SessionSystemMessage | SessionAgentMessage>;

export interface ClaudeSessionReplay {
    compactionSummary(): string | undefined;
    nativeCompaction(boundary: SDKCompactBoundaryMessage): Promise<AcpNativeCompaction>;
    entries(): readonly SessionStoreEntry[];
    message: SDKUserMessage;
    options: Pick<
        ClaudeSdkOptions,
        "persistSession" | "resume" | "resumeSessionAt" | "sessionStore" | "sessionStoreFlush"
    >;
    prompt: AsyncIterable<SDKUserMessage>;
}

export function createClaudeSessionReplay(options: {
    /** A native `/compact` query; its replay anchor also suppresses the loader placeholder. */
    compaction?: boolean;
    context: SessionContext;
    /** The directory the live query runs in; defaults to this process's own, as the SDK does. */
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    model: string;
    /**
     * The context's messages as stored, when `context` is this request's copy with its images
     * fitted: a native checkpoint replays its own entries, so it is checked against these.
     */
    retained?: readonly SessionMessage[];
    sessionId: string;
}): ClaudeSessionReplay {
    const messages = toReplayMessages(options.context.messages);
    const retained =
        options.retained === undefined ? messages : toReplayMessages(options.retained);
    if (retained.length !== messages.length)
        throw new Error("Claude's request history does not match the history it was fitted from.");
    const splitIndex = findPromptStart(messages);
    const history = messages.slice(0, splitIndex);
    const promptMessages = messages.slice(splitIndex);
    const entries = toSessionStoreEntries(
        history,
        {
            cwd: options.cwd ?? process.cwd(),
            env: options.env ?? process.env,
            model: options.model,
            sessionId: options.sessionId,
        },
        retained.slice(0, splitIndex),
    );
    let compactionSummary: string | undefined;
    const mirroredEntries = options.compaction === true ? [...entries] : [];
    const mirrorIndex = new Map(
        mirroredEntries.flatMap((entry, index) =>
            entry.uuid === undefined ? [] : [[entry.uuid, index] as const],
        ),
    );
    let mirrorBytes = mirroredEntries.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
        0,
    );
    if (mirrorBytes > 64 * 1024 * 1024 || mirroredEntries.length > 100_000)
        throw new Error("The native compaction transcript exceeds its bounded size.");
    const sessionStore: SessionStore = {
        append: (key, appendedEntries) => {
            // Rig owns the conversation. Ignore Claude's transcript mirror instead of making a
            // second history authoritative. Native compaction is the one exception in what we
            // observe: its replacement summary is a result, not resumable session state.
            if (key.sessionId === options.sessionId) {
                compactionSummary = findCompactionSummary(appendedEntries) ?? compactionSummary;
                if (options.compaction === true && key.subpath === undefined) {
                    for (const entry of appendedEntries) {
                        const index =
                            entry.uuid === undefined ? undefined : mirrorIndex.get(entry.uuid);
                        const bytes = Buffer.byteLength(JSON.stringify(entry));
                        const replaced =
                            index === undefined
                                ? 0
                                : Buffer.byteLength(JSON.stringify(mirroredEntries[index]));
                        if (
                            mirrorBytes + bytes - replaced > 64 * 1024 * 1024 ||
                            (index === undefined && mirroredEntries.length >= 100_000)
                        )
                            throw new Error(
                                "The native compaction transcript exceeds its bounded size.",
                            );
                        mirrorBytes += bytes - replaced;
                        if (index === undefined) {
                            if (entry.uuid !== undefined)
                                mirrorIndex.set(entry.uuid, mirroredEntries.length);
                            mirroredEntries.push(entry);
                        } else mirroredEntries[index] = entry;
                    }
                }
            }
            return Promise.resolve();
        },
        load: (key) =>
            Promise.resolve(
                key.sessionId === options.sessionId && key.subpath === undefined ? entries : null,
            ),
    };
    const message = toPromptMessage(promptMessages);
    // Claude Code's print-mode loader splices a synthetic assistant "No response requested." after
    // a transcript whose last message entry is user-role; attachments do not count as the end.
    // The model would take that line as its own. `--reply-on-resume` suppresses it only in the
    // interactive REPL, but the loader applies `resumeSessionAt` after the splice, so resuming at
    // the last replayed entry cuts the placeholder off. The same anchor is required for native
    // `/compact`: otherwise recent Claude Code preserves the placeholder in its checkpoint.
    const lastEntry = entries.at(-1);
    const endsOnUserTurn =
        entries.findLast((entry) => entry.type !== "attachment")?.type === "user";
    return {
        compactionSummary: () => compactionSummary,
        nativeCompaction: async (boundary) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return claudeNativeCompactionContext(
                        await readClaudeNativeCompaction({
                            sessionId: options.sessionId,
                            cwd: options.cwd ?? process.cwd(),
                            boundary,
                            entries: mirroredEntries,
                        }),
                    );
                } catch (error) {
                    if (!(error instanceof ClaudeNativeCompactionPendingError) || attempt === 2)
                        throw error;
                    await delay(attempt === 0 ? 125 : 500);
                }
            }
        },
        entries: () => entries,
        message,
        options: {
            persistSession: true,
            resume: options.sessionId,
            ...(endsOnUserTurn && typeof lastEntry?.uuid === "string"
                ? { resumeSessionAt: lastEntry.uuid }
                : {}),
            sessionStore,
            ...(options.compaction === true ? { sessionStoreFlush: "eager" as const } : {}),
        },
        prompt: singleMessagePrompt(message),
    };
}

export function createClaudeLivePromptMessage(
    sessionMessages: readonly SessionMessage[],
): SDKUserMessage {
    const messages = toReplayMessages(sessionMessages);
    let firstTrailingToolIndex = messages.length;
    while (firstTrailingToolIndex > 0 && messages[firstTrailingToolIndex - 1]?.role === "tool") {
        firstTrailingToolIndex -= 1;
    }
    return toPromptMessage(
        firstTrailingToolIndex === messages.length
            ? messages.slice(-1)
            : messages.slice(firstTrailingToolIndex),
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

function toPromptMessage(messages: readonly ReplayMessage[]): SDKUserMessage {
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
                return toToolResultBlock(message);
            }),
        },
    };
}

function toSessionStoreEntries(
    messages: readonly ReplayMessage[],
    options: { cwd: string; env: NodeJS.ProcessEnv; model: string; sessionId: string },
    retained: readonly ReplayMessage[] = messages,
): SessionStoreEntry[] {
    const native = nativeCheckpointEntries(messages, options, retained);
    if (native !== undefined) return native;
    let parentUuid: string | null = null;
    const assistantUuidByToolCallId = new Map<string, string>();
    const entries: SessionStoreEntry[] = [];
    // Claude Code records its environment, model, session-context, and date attachments right
    // after the first prompt and renders them as the system message that follows the first user
    // turn. A replay must carry the same attachments, in the same place, for a rebuilt session to
    // send the same bytes as the live one; without them the CLI appends its own copy at the end.
    let firstPromptAttachmentsPending = true;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined) continue;
        const uuid = stableMessageUuid(options.sessionId, message, index);
        const base = {
            // Rig runs every tool itself, so Claude Code never works from a caller-owned
            // directory. The transcript still needs the field expected by its resume path, and
            // the environment attachment must name the directory the live query runs in.
            cwd: options.cwd,
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
            let contentIndex = 0;
            let entryIndex = 0;
            const nextEntryUuid = (): string => {
                const entryUuid =
                    entryIndex === 0
                        ? uuid
                        : stableContentBlockUuid(options.sessionId, index, entryIndex);
                entryIndex += 1;
                return entryUuid;
            };
            while (contentIndex < message.content.length) {
                const assistantBlocks: SessionAssistantBlock[] = [];
                while (
                    contentIndex < message.content.length &&
                    message.content[contentIndex]?.type !== "tool_result"
                ) {
                    const block = message.content[contentIndex];
                    if (block !== undefined) assistantBlocks.push(block);
                    contentIndex += 1;
                }
                if (assistantBlocks.length > 0) {
                    const segmentUuid = nextEntryUuid();
                    const sdkMessage = toSdkAssistantMessage(
                        { role: "assistant", content: assistantBlocks },
                        options.model,
                        segmentUuid,
                    );
                    // Streaming persists one assistant entry per block. Siblings within one
                    // segment share the API message ID so Claude merges them on resume; an inline
                    // provider result ends that segment and becomes the intervening user entry.
                    for (const [blockIndex, block] of sdkMessage.content.entries()) {
                        const blockUuid = blockIndex === 0 ? segmentUuid : nextEntryUuid();
                        entries.push({
                            ...base,
                            parentUuid,
                            uuid: blockUuid,
                            message: { ...sdkMessage, content: [block] },
                            type: "assistant",
                        });
                        parentUuid = blockUuid;
                        if (
                            typeof block === "object" &&
                            block !== null &&
                            (block.type === "tool_use" ||
                                block.type === "mcp_tool_use" ||
                                block.type === "server_tool_use")
                        ) {
                            assistantUuidByToolCallId.set(block.id, blockUuid);
                        }
                    }
                }

                const toolResults: SessionToolResultBlock[] = [];
                while (message.content[contentIndex]?.type === "tool_result") {
                    toolResults.push(message.content[contentIndex] as SessionToolResultBlock);
                    contentIndex += 1;
                }
                if (toolResults.length > 0) {
                    const resultUuid = nextEntryUuid();
                    const sourceToolAssistantUUID = assistantUuidByToolCallId.get(
                        toolResults[0]!.callId,
                    );
                    entries.push({
                        ...base,
                        isMeta: true,
                        parentUuid,
                        uuid: resultUuid,
                        message: {
                            role: "user",
                            content: toolResults.map(toInlineToolResultBlock),
                        },
                        ...(sourceToolAssistantUUID === undefined
                            ? {}
                            : { sourceToolAssistantUUID }),
                        type: "user",
                    });
                    parentUuid = resultUuid;
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
            const sourceToolAssistantUUID = assistantUuidByToolCallId.get(message.callId);
            entries.push({
                ...base,
                isMeta: true,
                message: { role: "user", content: toolResults.map(toToolResultBlock) },
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
        if (firstPromptAttachmentsPending) {
            firstPromptAttachmentsPending = false;
            const attachments = claudeSessionAttachments({
                cwd: base.cwd,
                env: options.env,
                model: options.model,
            });
            for (const [attachmentIndex, attachment] of attachments.entries()) {
                const attachmentUuid = stableUuid(
                    options.sessionId,
                    `${index}:attachment:${attachmentIndex}`,
                );
                entries.push({
                    ...base,
                    attachment,
                    parentUuid,
                    type: "attachment",
                    uuid: attachmentUuid,
                });
                parentUuid = attachmentUuid;
            }
        }
    }
    return entries;
}

const nativeCheckpointSchema = Type.Object({
    type: Type.Literal("claude_code_compaction"),
    checkpointId: Type.String(),
    messages: Type.Array(
        Type.Object({
            type: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
            uuid: Type.String(),
            session_id: Type.String(),
            message: Type.Unknown(),
        }),
        { minItems: 1 },
    ),
});

/**
 * A portable checkpoint is for other vendors. Claude must resume its opaque native payload:
 * re-encoding its portable projection loses tool references, documents and signed blocks.
 * Verify the complete projection before replacing it, so no later work can be swallowed.
 * The projection is checked against the history as stored (`retained`), not this request's copy
 * with its images fitted: the checkpoint replays its own entries, images as Claude Code accepted
 * them, and only the work after it is sent from that copy.
 */
function nativeCheckpointEntries(
    messages: readonly ReplayMessage[],
    options: { cwd: string; env: NodeJS.ProcessEnv; model: string; sessionId: string },
    retained: readonly ReplayMessage[],
): SessionStoreEntry[] | undefined {
    const index = messages.findLastIndex(
        (message) =>
            message.role === "compaction" && message.vendor?.type === "claude_code_compaction",
    );
    if (index === -1) return undefined;
    const checkpoint = messages[index]!;
    if (
        checkpoint.role !== "compaction" ||
        checkpoint.content === null ||
        !Value.Check(nativeCheckpointSchema, checkpoint.vendor)
    ) {
        throw new Error("Claude cannot replay an invalid native checkpoint.");
    }
    const native = checkpoint.vendor.messages as NativeSessionMessage[];
    const summaries = native.filter(
        (message) =>
            message.type === "user" &&
            (message.message as { content?: unknown }).content === checkpoint.content,
    );
    if (summaries.length !== 1)
        throw new Error("Claude cannot identify the native checkpoint summary.");
    const expected = toReplayMessages(
        claudeNativeCompactionContext({
            boundaryId: checkpoint.vendor.checkpointId,
            summaryId: summaries[0]!.uuid,
            summary: checkpoint.content,
            messages: native,
            preTokens: 0,
        }).messages,
    );
    if (
        index !== expected.findIndex((message) => message.role === "compaction") ||
        messages.length < expected.length
    ) {
        throw new Error("Claude's native checkpoint does not match its retained history.");
    }
    const tail = messages.slice(expected.length);
    for (let i = 0; i < expected.length; i++) {
        const actual = retained[i]!;
        const wanted = expected[i]!;
        // Base joins adjacent assistant blocks on reload. Keep the later blocks outside the
        // checkpoint even when they share the last retained assistant message.
        if (
            i === expected.length - 1 &&
            actual.role === "assistant" &&
            wanted.role === "assistant"
        ) {
            if (
                deterministicStringify(actual.content.slice(0, wanted.content.length)) !==
                deterministicStringify(wanted.content)
            ) {
                throw new Error("Claude's native checkpoint does not match its retained history.");
            }
            const sent = messages[i]!;
            if (sent.role === "assistant" && sent.content.length > wanted.content.length) {
                tail.unshift({ ...sent, content: sent.content.slice(wanted.content.length) });
            }
        } else if (deterministicStringify(actual) !== deterministicStringify(wanted)) {
            throw new Error("Claude's native checkpoint does not match its retained history.");
        }
    }
    let parentUuid: string | null = null;
    const nativeIds = new Set(native.map((message) => message.uuid));
    if (nativeIds.size !== native.length) {
        throw new Error("Claude's native checkpoint contains duplicate message identities.");
    }
    const entries: SessionStoreEntry[] = native.map((message, i) => {
        // A native fork retains message identities. Metadata such as sourceToolAssistantUUID
        // and summarized-turn references must keep pointing at the exact preserved entries.
        const uuid = message.uuid;
        const entry = {
            ...message,
            cwd: options.cwd,
            entrypoint: "sdk-ts",
            isSidechain: false,
            parentUuid,
            sessionId: options.sessionId,
            timestamp: new Date(i).toISOString(),
            userType: "external",
            version: "happy-providers",
            uuid,
            type: message.type,
            message: structuredClone(message.message),
            ...(message.uuid === summaries[0]!.uuid ? { isCompactSummary: true } : {}),
        };
        parentUuid = uuid;
        return entry;
    });
    const later = toSessionStoreEntries(tail, options);
    // The first later entry joins this checkpoint; later entries already have a local chain.
    if (later[0] !== undefined) later[0] = { ...later[0], parentUuid };
    return [...entries, ...later];
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
            const native = nativeClaudeToolCall(block.vendor, block.callId);
            if (native !== undefined) return [native];
            return [
                {
                    type: "tool_use" as const,
                    id: block.callId,
                    name: claudeToolWireName(block),
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

function claudeToolWireName(block: { name: string; vendor?: unknown }): string {
    const vendor = block.vendor;
    return typeof vendor === "object" &&
        vendor !== null &&
        "type" in vendor &&
        vendor.type === "claude_tool_use" &&
        "wireName" in vendor &&
        typeof vendor.wireName === "string"
        ? vendor.wireName
        : block.name;
}

const nativeToolCallSchema = Type.Object({
    type: Type.Union([
        Type.Literal("tool_use"),
        Type.Literal("mcp_tool_use"),
        Type.Literal("server_tool_use"),
    ]),
    id: Type.String(),
    name: Type.String(),
    input: Type.Record(Type.String(), Type.Unknown()),
});
const nativeToolResultSchema = Type.Object({
    type: Type.Literal("tool_result"),
    tool_use_id: Type.String(),
});
const nativeEnvelopeSchema = Type.Object({ type: Type.String(), native: Type.Unknown() });

function nativeClaudeToolCall(
    vendor: unknown,
    callId: string,
): Record<string, unknown> | undefined {
    if (!Value.Check(nativeEnvelopeSchema, vendor) || vendor.type !== "claude_tool_use")
        return undefined;
    if (!Value.Check(nativeToolCallSchema, vendor.native) || vendor.native.id !== callId) {
        throw new Error("Claude cannot replay an invalid native tool call.");
    }
    return structuredClone(vendor.native);
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

function toToolResultBlock(message: SessionToolResultMessage) {
    const native = nativeClaudeToolResult(message.vendor);
    if (native !== undefined) return { ...native, tool_use_id: message.callId };
    return {
        type: "tool_result" as const,
        tool_use_id: message.callId,
        content: toSdkContent(message.content),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
    };
}

function toInlineToolResultBlock(block: SessionToolResultBlock) {
    const native = nativeClaudeToolResult(block.vendor);
    return native === undefined
        ? {
              type: "tool_result" as const,
              tool_use_id: block.callId,
              content: toSdkContent(block.content),
              ...(block.isError === undefined ? {} : { is_error: block.isError }),
          }
        : { ...native, tool_use_id: block.callId };
}

function nativeClaudeToolResult(
    vendor: unknown,
): Static<typeof nativeToolResultSchema> | undefined {
    if (Value.Check(nativeEnvelopeSchema, vendor) && vendor.type === "claude_native_tool_result") {
        if (!Value.Check(nativeToolResultSchema, vendor.native)) {
            throw new Error("Claude cannot replay an invalid native tool result.");
        }
        return structuredClone(vendor.native);
    }
    if (
        typeof vendor !== "object" ||
        vendor === null ||
        !("outputBlock" in vendor) ||
        typeof vendor.outputBlock !== "string"
    ) {
        return undefined;
    }
    try {
        const block: unknown = JSON.parse(vendor.outputBlock);
        return Value.Check(nativeToolResultSchema, block) ? block : undefined;
    } catch {
        return undefined;
    }
}

function toSdkContent(content: readonly SessionInputBlock[]) {
    if (content.length === 1 && content[0]?.type === "text") return content[0].text;
    return content.map(toContentBlock);
}

function toContentBlock(block: SessionInputBlock) {
    if (block.type === "tool_call_request") {
        throw new Error("Tool requests must be executed by the agent before inference.");
    }
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.data.length > CLAUDE_IMAGE_BASE64_LIMIT) {
        return { type: "text" as const, text: omittedImageText(block.data.length) };
    }
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

/**
 * `fitClaudeImages` shrinks an oversized image before replay. One it could not shrink is projected
 * to a note in this request only, since Claude Code would refuse the whole request; the caller's
 * history keeps it.
 */
function omittedImageText(length: number): string {
    const megabytes = (Math.ceil((length / (1024 * 1024)) * 10) / 10).toFixed(1);
    return `[Image omitted: its base64 data is ${megabytes} MB, over Claude's 5 MB limit for one image.]`;
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
