import type * as acp from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Translate Claude Agent SDK messages into ACP session updates for one query. Text and thinking
 * stream from partial messages; tool calls come from each completed assistant message, and their
 * results from the user messages Claude Code adds. A subagent's own messages stay inside its
 * Task call, as they do in Claude Code. The lines Claude Code shows the person itself, such as a
 * hook's `systemMessage`, become finished tool calls, so they are shown without becoming part of
 * the reply.
 */
export function claudeAgentUpdates(): {
    translate(message: SDKMessage): acp.SessionUpdate[];
} {
    const titles = new Map<string, string>();
    return {
        translate(message) {
            if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null) return [];
            if (message.type === "stream_event") {
                const event = message.event;
                if (event.type !== "content_block_delta") return [];
                if (event.delta.type === "text_delta") {
                    return [
                        {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: event.delta.text },
                        },
                    ];
                }
                if (event.delta.type === "thinking_delta") {
                    return [
                        {
                            sessionUpdate: "agent_thought_chunk",
                            content: { type: "text", text: event.delta.thinking },
                        },
                    ];
                }
                return [];
            }
            if (message.type === "assistant") {
                return message.message.content.flatMap((block): acp.SessionUpdate[] => {
                    if (block.type !== "tool_use" && block.type !== "mcp_tool_use") return [];
                    const name =
                        "server_name" in block
                            ? `mcp__${block.server_name}__${block.name}`
                            : block.name;
                    titles.set(block.id, name);
                    return [
                        {
                            sessionUpdate: "tool_call",
                            toolCallId: block.id,
                            title: toolTitle(name, block.input),
                            kind: toolKind(name),
                            status: "in_progress",
                            rawInput: block.input as Record<string, unknown>,
                            locations: toolLocations(block.input),
                        },
                    ];
                });
            }
            if (message.type === "user" && Array.isArray(message.message.content)) {
                return message.message.content.flatMap((block): acp.SessionUpdate[] => {
                    if (typeof block !== "object" || block.type !== "tool_result") return [];
                    if (!titles.has(block.tool_use_id)) return [];
                    titles.delete(block.tool_use_id);
                    return [
                        {
                            sessionUpdate: "tool_call_update",
                            toolCallId: block.tool_use_id,
                            status: block.is_error === true ? "failed" : "completed",
                            content: [
                                {
                                    type: "content",
                                    content: { type: "text", text: resultText(block.content) },
                                },
                            ],
                        },
                    ];
                });
            }
            if (message.type === "system" && message.subtype === "informational") {
                return noticeUpdates(message);
            }
            if (message.type === "result" && message.usage !== undefined) {
                return [];
            }
            return [];
        },
    };
}

/**
 * A line Claude Code shows the person, as `Stop says: …` for a hook's `systemMessage`. Claude Code
 * shows level `info` only in its transcript view, so it is left out here too.
 */
function noticeUpdates(
    message: Extract<SDKMessage, { type: "system"; subtype: "informational" }>,
): acp.SessionUpdate[] {
    const text = message.content.trim();
    if (message.level === "info" || text === "") return [];
    return [
        {
            sessionUpdate: "tool_call",
            toolCallId: `notice-${message.uuid}`,
            title: text.split("\n", 1)[0]!,
            kind: "other",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text } }],
        },
    ];
}

/** A Happy tool reaches Claude as `mcp__happy__<name>`; the title keeps that so it is recognized. */
function toolTitle(name: string, input: unknown): string {
    if (name.startsWith("mcp__")) return name;
    const record = (input ?? {}) as Record<string, unknown>;
    const detail =
        record["command"] ??
        record["file_path"] ??
        record["pattern"] ??
        record["url"] ??
        record["description"];
    return typeof detail === "string" && detail.length > 0 ? `${name}: ${detail}` : name;
}

function toolKind(name: string): acp.ToolKind {
    if (name === "Bash") return "execute";
    if (name === "Read" || name === "NotebookRead") return "read";
    if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
        return "edit";
    }
    if (name === "Grep" || name === "Glob") return "search";
    if (name === "WebFetch" || name === "WebSearch") return "fetch";
    if (name === "Task" || name === "Agent" || name === "TodoWrite") return "think";
    return "other";
}

function toolLocations(input: unknown): acp.ToolCallLocation[] {
    const path = (input as Record<string, unknown> | null)?.["file_path"];
    return typeof path === "string" ? [{ path }] : [];
}

function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part: { type?: string; text?: string }) =>
            part.type === "text" ? (part.text ?? "") : "",
        )
        .join("");
}
