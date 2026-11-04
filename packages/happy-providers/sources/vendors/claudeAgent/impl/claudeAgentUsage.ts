import type * as acp from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface CallUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
}

/**
 * A turn's usage as Happy reads it. Input is the context the conversation now fills: the prompt
 * of the turn's last main-thread API call, cached part included, as the native Claude and Codex
 * paths report it. Claude Code's result instead sums every call of the turn and counts only
 * uncached input, which reads as an almost empty context once the prompt is cached.
 */
export function claudeAgentUsage(): {
    observe(message: SDKMessage): void;
    settle(result: Extract<SDKMessage, { type: "result" }>): acp.Usage;
} {
    let call: CallUsage | undefined;
    return {
        observe(message) {
            if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return;
            const event = message.event;
            if (event.type === "message_start") {
                const usage = event.message.usage;
                call = {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                };
            } else if (event.type === "message_delta" && call !== undefined) {
                const usage = event.usage;
                call = {
                    input_tokens: usage.input_tokens ?? call.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read_input_tokens:
                        usage.cache_read_input_tokens ?? call.cache_read_input_tokens,
                    cache_creation_input_tokens:
                        usage.cache_creation_input_tokens ?? call.cache_creation_input_tokens,
                };
            }
        },
        settle(result) {
            const used = call ?? result.usage;
            call = undefined;
            const cachedReadTokens = used.cache_read_input_tokens ?? 0;
            const cachedWriteTokens = used.cache_creation_input_tokens ?? 0;
            const inputTokens = used.input_tokens + cachedReadTokens + cachedWriteTokens;
            return {
                inputTokens,
                outputTokens: used.output_tokens,
                cachedReadTokens,
                cachedWriteTokens,
                totalTokens: inputTokens + used.output_tokens,
            };
        },
    };
}
