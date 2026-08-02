import { createHash } from "node:crypto";

import type { SessionMessage } from "@/core/SessionContext.js";

/**
 * What a message looks like once Claude has it, rather than how the caller happens to hold it.
 *
 * A live SDK query keeps its own copy of the conversation, so deciding whether to continue one
 * means comparing against what Claude was actually sent. The caller's copy of the same turn is
 * not byte-identical: an executor round trip decorates an assistant with fields such as
 * `encryptedReasoning` and `responseItems` that never reach the wire. Comparing raw messages
 * would restart the query on every tool call; comparing the projection Claude receives keeps the
 * live tool loop intact while still catching a genuine rewrite.
 */
export function claudeMessageIdentity(message: SessionMessage): string {
    return createHash("sha256")
        .update(JSON.stringify(toIdentity(message)))
        .digest("base64");
}

function toIdentity(message: SessionMessage): unknown {
    if (message.role === "assistant") {
        // Reasoning is deliberately absent. Claude owns the authoritative thinking blocks for a
        // turn it generated, and a caller replaying that turn may carry them, re-encode them as
        // `encryptedReasoning`, or omit them entirely. Only the text and tool calls decide whether
        // this is the same turn.
        return {
            role: "assistant",
            content: message.content,
            toolCalls: (message.toolCalls ?? []).map((call) => [
                call.callId,
                call.name,
                call.arguments,
            ]),
        };
    }
    if (message.role === "tool") {
        return {
            role: "tool",
            callId: message.callId,
            content: message.content,
            input: message.input,
            isError: message.isError,
        };
    }
    if (message.role === "agent") {
        throw new Error("Encrypted Codex agent messages cannot be replayed by Claude.");
    }
    return {
        role: message.role,
        content: message.content,
        input: message.role === "user" ? message.input : undefined,
    };
}
