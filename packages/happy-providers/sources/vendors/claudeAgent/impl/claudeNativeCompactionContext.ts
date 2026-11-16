import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    SessionAssistantBlock,
    SessionCompactionMessage,
    SessionInputBlock,
    SessionMessage,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import type { AcpNativeCompaction } from "@/protocol/acp/AcpConnection.js";
import type { ClaudeNativeCompaction } from "./readClaudeNativeCompaction.js";

const text = Type.Object({
    type: Type.Literal("text"),
    text: Type.String(),
    citations: Type.Optional(Type.Unknown()),
});
const image = Type.Object({
    type: Type.Literal("image"),
    source: Type.Object({
        type: Type.Literal("base64"),
        data: Type.String(),
        media_type: Type.String(),
    }),
});
const nativeBlock = Type.Intersect([
    Type.Object({ type: Type.String({ minLength: 1 }) }),
    Type.Record(Type.String(), Type.Unknown()),
]);
const nativeContent = Type.Union([Type.String(), Type.Array(nativeBlock), nativeBlock]);
const result = Type.Object({
    type: Type.Literal("tool_result"),
    tool_use_id: Type.String(),
    content: Type.Optional(nativeContent),
    is_error: Type.Optional(Type.Boolean()),
});
const userBody = Type.Object({
    role: Type.Literal("user"),
    content: Type.Union([Type.String(), Type.Array(nativeBlock)]),
});
const thinking = Type.Object({
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    signature: Type.Optional(Type.String()),
});
const redacted = Type.Object({
    type: Type.Literal("redacted_thinking"),
    data: Type.String(),
});
const tool = Type.Object({
    type: Type.Union([
        Type.Literal("tool_use"),
        Type.Literal("server_tool_use"),
        Type.Literal("mcp_tool_use"),
    ]),
    id: Type.String(),
    name: Type.String(),
    input: Type.Record(Type.String(), Type.Unknown()),
    server_name: Type.Optional(Type.String()),
});
const assistantBody = Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(nativeBlock),
});

/** Convert only the checkpoint's native preserved tail; never summarize or truncate it again. */
export function claudeNativeCompactionContext(
    checkpoint: ClaudeNativeCompaction,
): AcpNativeCompaction {
    const preservedMessages: SessionMessage[] = [];
    const messages: SessionMessage[] = [];
    const compaction: SessionCompactionMessage = {
        role: "compaction",
        content: checkpoint.summary,
        encryptedContent: null,
        vendor: {
            type: "claude_code_compaction",
            checkpointId: checkpoint.boundaryId,
            messages: structuredClone(checkpoint.messages),
        },
    };
    for (const message of checkpoint.messages) {
        if (message.uuid === checkpoint.summaryId) {
            messages.push(compaction);
            continue;
        }
        const preservedBefore = preservedMessages.length;
        if (message.type === "user" && Value.Check(userBody, message.message)) {
            let pending: SessionInputBlock[] = [];
            const flush = () => {
                if (pending.length > 0) preservedMessages.push({ role: "user", content: pending });
                pending = [];
            };
            const blocks =
                typeof message.message.content === "string"
                    ? [{ type: "text" as const, text: message.message.content }]
                    : message.message.content;
            for (const block of blocks) {
                if (block.type !== "tool_result") {
                    pending.push(...portableNativeBlock(block));
                    continue;
                }
                if (!Value.Check(result, block))
                    throw new Error("Claude retained an invalid native tool result.");
                flush();
                preservedMessages.push({
                    role: "tool",
                    callId: block.tool_use_id,
                    content: portableNativeContent(block.content),
                    ...(block.is_error === undefined ? {} : { isError: block.is_error }),
                    vendor: {
                        type: "claude_native_tool_result",
                        native: structuredClone(block),
                    },
                });
            }
            flush();
        } else if (message.type === "assistant" && Value.Check(assistantBody, message.message)) {
            const content: SessionAssistantBlock[] = message.message.content.flatMap(
                (block): SessionAssistantBlock[] => {
                    if (Value.Check(thinking, block))
                        return [
                            {
                                type: "reasoning",
                                text: block.thinking,
                                ...(block.signature === undefined
                                    ? {}
                                    : { reasoning: block.signature }),
                            },
                        ];
                    if (Value.Check(redacted, block))
                        return [{ type: "reasoning", reasoning: block.data }];
                    if (Value.Check(tool, block))
                        return [
                            {
                                type: "tool_call",
                                callId: block.id,
                                name:
                                    block.server_name === undefined
                                        ? block.name
                                        : `mcp__${block.server_name}__${block.name}`,
                                arguments: JSON.stringify(block.input),
                                server: true,
                                vendor: {
                                    type: "claude_tool_use",
                                    native: structuredClone(block),
                                },
                            },
                        ];
                    if (
                        block.type.endsWith("_tool_result") &&
                        typeof block["tool_use_id"] === "string"
                    ) {
                        return [
                            {
                                type: "tool_result",
                                callId: block["tool_use_id"],
                                content: portableNativeContent(block["content"]),
                                vendor: {
                                    type: "claude_native_tool_result",
                                    native: structuredClone(block),
                                },
                            },
                        ];
                    }
                    return portableNativeBlock(block).map(
                        (projected): SessionAssistantBlock =>
                            projected.type === "text"
                                ? projected
                                : {
                                      type: "text",
                                      text: "[Native image retained in checkpoint]",
                                  },
                    );
                },
            );
            preservedMessages.push({ role: "assistant", content });
        } else {
            throw new Error(
                "Claude native compaction retained content that cannot be replayed faithfully.",
            );
        }
        messages.push(...preservedMessages.slice(preservedBefore));
    }
    return {
        checkpointId: checkpoint.boundaryId,
        compaction,
        messages,
        preservedMessages,
        usage: {
            input: checkpoint.preTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: checkpoint.preTokens,
        },
    };
}

/** ACP accepts text/image prompts; opaque native state above retains the original blocks. */
function portableNativeContent(content: unknown): SessionOutputBlock[] {
    if (content === undefined) return [];
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content))
        return content.flatMap((block) => {
            if (!Value.Check(nativeBlock, block))
                throw new Error("Claude retained an invalid native content block.");
            return portableNativeBlock(block);
        });
    if (!Value.Check(nativeBlock, content))
        throw new Error("Claude retained an invalid native content block.");
    return portableNativeBlock(content);
}

function portableNativeBlock(block: Static<typeof nativeBlock>): SessionOutputBlock[] {
    if (Value.Check(text, block)) {
        const blocks: SessionOutputBlock[] = [{ type: "text", text: block.text }];
        if (block.citations !== undefined)
            blocks.push({
                type: "text",
                text: `[Native citations] ${JSON.stringify(block.citations)}`,
            });
        return blocks;
    }
    if (Value.Check(image, block))
        return [
            {
                type: "image",
                data: block.source.data,
                mimeType: block.source.media_type,
            },
        ];
    return [
        {
            type: "text",
            text: `[Native ${block.type}] ${JSON.stringify(portableStructuredValue(block))}`,
        },
    ];
}

/** Binary attachments remain opaque; never inflate their base64 into a text-only handoff. */
function portableStructuredValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(portableStructuredValue);
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const binary = record["type"] === "base64" || record["encoding"] === "base64";
        return Object.fromEntries(
            Object.entries(record).map(([key, entry]) => [
                key,
                binary && key === "data"
                    ? "[Binary attachment retained in native checkpoint]"
                    : portableStructuredValue(entry),
            ]),
        );
    }
    return value;
}
