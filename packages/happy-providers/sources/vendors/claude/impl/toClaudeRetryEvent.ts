import type { SDKAPIRetryMessage } from "@anthropic-ai/claude-agent-sdk";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { classifyClaudeRetry } from "@/vendors/claude/errors/claudeErrors.js";

export function toClaudeRetryEvent(message: SDKAPIRetryMessage): SessionEvent {
    const status =
        message.error_status === null ? "connection failure" : `HTTP ${message.error_status}`;
    const delay = formatDelay(message.retry_delay_ms);
    return {
        type: "retrying",
        attempt: message.attempt,
        reason: `Claude API ${message.error.replaceAll("_", " ")} (${status}); retrying in ${delay}, attempt ${message.attempt} of ${message.max_retries}.`,
        providerError: classifyClaudeRetry(message),
    };
}

function formatDelay(milliseconds: number): string {
    if (milliseconds < 1_000) return `${milliseconds} ms`;
    const seconds = milliseconds / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}
