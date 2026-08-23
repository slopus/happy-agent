import { createHash } from "node:crypto";

import type { SessionMessage } from "@/core/SessionContext.js";

/**
 * What a message looks like once Claude has it, rather than how the caller happens to hold it.
 *
 * A live SDK query keeps its own copy of the conversation, so deciding whether to continue one
 * means comparing against what Claude was actually sent. The caller's copy of the same turn is
 * not byte-identical: an executor round trip can retain provider replay state on reasoning and
 * server-tool blocks. Comparing the wire-visible projection keeps the live tool loop intact while
 * still catching a genuine rewrite.
 */
export function claudeMessageIdentity(message: SessionMessage): string {
    return createHash("sha256")
        .update(JSON.stringify(toIdentity(message)))
        .digest("base64");
}

function toIdentity(message: SessionMessage): unknown {
    if (message.role === "assistant") {
        const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text);
        const toolCalls = message.content.filter((block) => block.type === "tool_call");
        return {
            role: "assistant",
            content: text,
            toolCalls: toolCalls.map((call) => [
                call.callId,
                call.name,
                normalizeArguments(call.arguments),
            ]),
        };
    }
    if (message.role === "tool") {
        return {
            role: "tool",
            callId: message.callId,
            content: message.content,
            isError: message.isError,
        };
    }
    if (message.role === "agent") {
        // The author is part of the identity: the same words from a different agent are a
        // different message, and Claude is told which one sent them.
        return { role: "agent", author: message.author, content: message.content };
    }
    return {
        role: message.role,
        content: message.content,
    };
}

function normalizeArguments(argumentsJson: string): string {
    try {
        return JSON.stringify(JSON.parse(argumentsJson));
    } catch {
        return argumentsJson;
    }
}
