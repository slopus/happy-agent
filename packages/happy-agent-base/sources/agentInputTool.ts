import { sessionInputToolSchema, type SessionInputTool } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";

import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";

/** Validate and locate the one control block a queued user message may carry. */
export function agentInputTool(message: AgentQueuedMessage): SessionInputTool | undefined {
    let request: SessionInputTool | undefined;
    for (const block of message.content) {
        if (block.type !== "tool_call_request") continue;
        if (message.role !== "user") {
            throw new Error("Only user messages may request a tool call.");
        }
        if (request !== undefined) {
            throw new Error("A user message may request at most one tool call.");
        }
        if (!Value.Check(sessionInputToolSchema, block)) {
            throw new Error("The user message contains an invalid tool request.");
        }
        request = block;
    }
    return request;
}
