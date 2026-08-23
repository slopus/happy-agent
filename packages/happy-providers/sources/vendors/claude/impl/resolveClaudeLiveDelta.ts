import type { SessionMessage, SessionToolResultMessage } from "@/core/SessionContext.js";
import { toProviderToolResultMessage } from "@/core/SessionToolCallId.js";

/** The one turn a live Claude query can be handed without replaying the conversation. */
export type ClaudeLiveDelta =
    | { kind: "restart" }
    | { kind: "prompt" }
    | { kind: "tool_results"; results: readonly SessionToolResultMessage[] };

/**
 * Decide whether the caller's conversation can continue the live query, or has to replay.
 *
 * A live query may only be advanced by what its prompt queue can actually deliver: the complete
 * result batch for the tool calls it is waiting on, or a single trailing prompt. Everything the
 * caller sent before that must already be inside the query, so anything else - a compaction, an
 * edit, a rewind, or a second message queued behind the prompt - has to start over. Continuing
 * on a looser rule silently drops the extra messages while Claude keeps billing its own history.
 */
export function resolveClaudeLiveDelta(options: {
    messages: readonly SessionMessage[];
    incoming: readonly string[];
    sent: readonly string[] | undefined;
    pendingToolCallIds: readonly string[];
    resolveProviderCallId: (callId: string) => string;
}): ClaudeLiveDelta {
    const { incoming, messages, pendingToolCallIds, resolveProviderCallId, sent } = options;
    if (sent === undefined) return { kind: "restart" };
    if (sent.length > incoming.length) return { kind: "restart" };
    if (!sent.every((identity, index) => identity === incoming[index])) return { kind: "restart" };

    const suffix = messages.slice(sent.length);
    if (pendingToolCallIds.length > 0) {
        const results = suffix.filter((message) => message.role === "tool");
        if (results.length !== suffix.length) return { kind: "restart" };
        const providerResults = results.map((result) =>
            toProviderToolResultMessage(resolveProviderCallId, result),
        );
        if (!coversExactly(pendingToolCallIds, providerResults)) return { kind: "restart" };
        return { kind: "tool_results", results: providerResults };
    }
    if (suffix.length !== 1) return { kind: "restart" };
    if (suffix[0]?.role === "tool") return { kind: "restart" };
    return { kind: "prompt" };
}

function coversExactly(
    pendingToolCallIds: readonly string[],
    results: readonly SessionToolResultMessage[],
): boolean {
    if (results.length !== pendingToolCallIds.length) return false;
    const pending = new Set(pendingToolCallIds);
    return results.every((result) => pending.delete(result.callId)) && pending.size === 0;
}
