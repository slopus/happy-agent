import type { AgentBlock, Message, SystemMessage } from "../../agent/index.js";
import type { SessionTranscriptWindow } from "../index.js";

const CLIENT_BLOCK_MAXIMUM_TEXT_BYTES = 32 * 1_024;
const CLIENT_IMAGE_MAXIMUM_BASE64_BYTES = 512 * 1_024;
const CLIENT_STRUCTURED_VALUE_MAXIMUM_BYTES = 16 * 1_024;
const CLIENT_TRUNCATION_NOTICE = "\n\n[Content truncated in initial history.]";

/**
 * Removes provider-continuation and model-only data from a transcript sent to an application.
 *
 * The durable transcript is also the model transcript, so messages can contain encrypted
 * reasoning, native continuation items, compaction replacements, and complete tool output. None
 * of those values are rendered by Rig Connect. Shipping them made one visually ordinary turn
 * several megabytes large.
 */
export function projectClientTranscript(
    transcript: SessionTranscriptWindow,
): SessionTranscriptWindow {
    const messages = transcript.messages;
    const retainedIds = new Set(messages.map((message) => message.id));
    return {
        ...transcript,
        messages: messages.map(projectClientMessage),
        turns: transcript.turns
            .map((turn) => ({
                ...turn,
                messageIds: turn.messageIds.filter((id) => retainedIds.has(id)),
            }))
            .filter((turn) => turn.messageIds.length > 0),
        ...projectMessageRecord("messageBoundaryGroupId", transcript, retainedIds),
        ...projectMessageRecord("messageCreatedAt", transcript, retainedIds),
        ...projectMessageRecord("messageEventId", transcript, retainedIds),
        ...projectMessageRecord("messageGroupId", transcript, retainedIds),
        ...projectMessageRecord("messageSteeredAt", transcript, retainedIds),
        ...(transcript.notices === undefined
            ? {}
            : {
                  notices: transcript.notices.map((notice) => ({
                      ...notice,
                      message: projectClientMessage(notice.message) as SystemMessage,
                  })),
              }),
    };
}

function projectMessageRecord<
    Key extends
        | "messageBoundaryGroupId"
        | "messageCreatedAt"
        | "messageEventId"
        | "messageGroupId"
        | "messageSteeredAt",
>(
    key: Key,
    transcript: SessionTranscriptWindow,
    retainedIds: ReadonlySet<string>,
): Pick<SessionTranscriptWindow, Key> | Record<never, never> {
    const record = transcript[key];
    if (record === undefined) return {};
    return {
        [key]: Object.fromEntries(
            Object.entries(record).filter(([messageId]) => retainedIds.has(messageId)),
        ),
    } as Pick<SessionTranscriptWindow, Key>;
}

function projectClientMessage(message: Message): Message {
    switch (message.role) {
        case "agent": {
            const { sessionMessage: _sessionMessage, ...visible } = message;
            return { ...visible, blocks: visible.blocks.map(projectClientAgentBlock) };
        }
        case "compaction": {
            const {
                replacementMessages: _replacementMessages,
                replacedMessageIds: _replacedMessageIds,
                ...visible
            } = message;
            return {
                ...visible,
                blocks: visible.blocks.map(projectClientContentBlock),
                replacedMessageIds: [],
            };
        }
        case "error": {
            const { providerError: _providerError, ...visible } = message;
            return { ...visible, blocks: visible.blocks.map(projectClientContentBlock) };
        }
        case "user": {
            const { encryptedAgentMessage: _encryptedAgentMessage, ...visible } = message;
            return { ...visible, blocks: visible.blocks.map(projectClientContentBlock) };
        }
        case "system":
            return { ...message, blocks: message.blocks.map(projectClientContentBlock) };
    }
}

function projectClientAgentBlock(block: AgentBlock): AgentBlock {
    switch (block.type) {
        case "thinking": {
            const { encrypted: _encrypted, ...visible } = block;
            return { ...visible, thinking: boundClientText(visible.thinking) };
        }
        case "tool_call": {
            const { presentation, vendor: _vendor, ...visible } = block;
            return {
                ...visible,
                arguments: boundClientValue(visible.arguments),
                ...(presentation === undefined ||
                serializedBytes(presentation) > CLIENT_STRUCTURED_VALUE_MAXIMUM_BYTES
                    ? {}
                    : { presentation }),
            };
        }
        case "tool_result": {
            const {
                presentation,
                rendered: _rendered,
                trustedUserEvidence: _trustedUserEvidence,
                vendor: _vendor,
                ...visible
            } = block;
            return {
                ...visible,
                rendered: [],
                ...(presentation === undefined ||
                serializedBytes(presentation) > CLIENT_STRUCTURED_VALUE_MAXIMUM_BYTES
                    ? {}
                    : { presentation }),
            };
        }
        case "image":
        case "text":
            return projectClientContentBlock(block);
    }
}

function projectClientContentBlock(
    block: Extract<AgentBlock, { type: "image" | "text" }>,
): Extract<AgentBlock, { type: "image" | "text" }> {
    if (block.type === "text") return { ...block, text: boundClientText(block.text) };
    if (Buffer.byteLength(block.data) <= CLIENT_IMAGE_MAXIMUM_BASE64_BYTES) return block;
    return {
        text: "[Image omitted from initial history because it is too large.]",
        type: "text",
    };
}

function boundClientText(value: string): string {
    if (Buffer.byteLength(value) <= CLIENT_BLOCK_MAXIMUM_TEXT_BYTES) return value;
    const notice = Buffer.from(CLIENT_TRUNCATION_NOTICE);
    const available = Math.max(0, CLIENT_BLOCK_MAXIMUM_TEXT_BYTES - notice.byteLength);
    const source = Buffer.from(value);
    let end = Math.min(source.byteLength, available);
    while (end > 0 && ((source[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return `${source.subarray(0, end).toString("utf8")}${CLIENT_TRUNCATION_NOTICE}`;
}

function boundClientValue(value: unknown): unknown {
    return serializedBytes(value) <= CLIENT_STRUCTURED_VALUE_MAXIMUM_BYTES
        ? value
        : { omitted: "Structured content is too large for initial history." };
}

function serializedBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? "");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
