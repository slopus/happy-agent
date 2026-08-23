import type { SessionMessage } from "@slopus/happy-providers";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

/**
 * Backing storage for `agentTaskContext`: the parent conversation before a tool call. Not
 * detachable — the snapshot describes the call the work is running inside, so an agent that
 * detaches to a lifetime of its own begins with no parent conversation instead of silently
 * inheriting somebody else's. A child meant to see it is handed it deliberately.
 */
const taskContextNamespace = createContextNamespace<readonly SessionMessage[] | undefined>(
    "happyAgent.taskContext",
    undefined,
    { detachable: false },
);

/**
 * Carry the parent conversation that existed before the assistant response containing the
 * current tool call. The snapshot is immutable caller context: collaboration can fork it without
 * gaining a general-purpose history-reading capability.
 */
export function withAgentTaskContext(ctx: Context, messages: readonly SessionMessage[]): Context {
    return taskContextNamespace.set(ctx, publicTaskContext(messages));
}

/** The pre-tool-call parent conversation available to the current tool execution. */
export function agentTaskContext(ctx: Context): readonly SessionMessage[] {
    return structuredClone(taskContextNamespace.get(ctx) ?? []);
}

/**
 * Select everything before the assistant response that issued `callId`. Removing the complete
 * response follows Codex's fork boundary and prevents sibling calls, reasoning, or prefatory
 * assistant text from leaking into a child while that response is still being settled.
 */
export function taskContextBeforeToolCall(
    messages: readonly SessionMessage[],
    callId: string,
): readonly SessionMessage[] {
    const boundary = messages.findIndex(
        (message) =>
            message.role === "assistant" &&
            message.content.some((block) => block.type === "tool_call" && block.callId === callId),
    );
    return publicTaskContext(boundary < 0 ? messages : messages.slice(0, boundary));
}

/** Tool work may inherit portable conversation content, never opaque provider replay state. */
function publicTaskContext(messages: readonly SessionMessage[]): SessionMessage[] {
    return structuredClone(
        messages.map((message): SessionMessage => {
            if (message.role === "assistant") {
                return {
                    ...message,
                    content: message.content.map((block) => {
                        if (block.type !== "tool_call" && block.type !== "tool_result")
                            return block;
                        const { vendor: _vendor, ...publicBlock } = block;
                        return publicBlock;
                    }),
                };
            }
            if (message.role === "tool" || message.role === "compaction") {
                const { vendor: _vendor, ...publicMessage } = message;
                return publicMessage;
            }
            return message;
        }),
    );
}
