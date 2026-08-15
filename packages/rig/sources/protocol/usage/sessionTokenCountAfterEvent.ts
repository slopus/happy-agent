import type { SessionEvent, SessionTokenCount } from "../index.js";
import { updateSessionTokenCount } from "./updateSessionTokenCount.js";

export function sessionTokenCountAfterEvent(
    current: SessionTokenCount | undefined,
    event: SessionEvent,
): SessionTokenCount | undefined {
    if (event.type === "session_reset") {
        return updateSessionTokenCount(current, { type: "reset" });
    }
    if (
        event.type === "session_rewound" ||
        (event.type === "session_configuration_changed" && event.data.changed.includes("model"))
    ) {
        return updateSessionTokenCount(current, { type: "invalidate_context" });
    }
    if (event.type === "agent_event" && event.data.event.type === "context_compacted") {
        return updateSessionTokenCount(current, {
            type: "compaction",
            contextTokens: event.data.event.estimatedTokensAfter,
        });
    }
    if (
        event.type === "agent_message" &&
        event.data.message.role === "agent" &&
        event.data.message.usage !== undefined
    ) {
        return updateSessionTokenCount(current, {
            type: "usage",
            contextTokens: event.data.message.contextTokens ?? current?.lastContextTokens ?? 0,
            usage: event.data.message.usage,
        });
    }
    if (
        event.type === "agent_message" &&
        event.data.message.role === "compaction" &&
        event.data.message.usage !== undefined
    ) {
        return updateSessionTokenCount(current, {
            type: "usage",
            contextTokens: current?.lastContextTokens ?? event.data.message.statistics.after.tokens,
            usage: event.data.message.usage,
        });
    }
    if (
        event.type === "agent_event" &&
        event.data.event.type === "permission_review" &&
        event.data.event.transcript !== undefined
    ) {
        return updateSessionTokenCount(current, {
            type: "usage",
            contextTokens: current?.lastContextTokens ?? 0,
            usage: event.data.event.transcript.usage,
        });
    }
    return current;
}
