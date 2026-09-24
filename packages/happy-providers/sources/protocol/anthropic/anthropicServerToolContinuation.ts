import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isDeepStrictEqual } from "node:util";

import type {
    SessionAssistantBlock,
    SessionMessage,
    SessionToolCallBlock,
} from "@/core/SessionContext.js";

const outputMetadata = Type.Object({ outputBlock: Type.String() });
const continuationMetadata = Type.Object({ anthropicServerToolContinuation: Type.Literal(true) });
const serverCall = Type.Object({
    type: Type.Literal("server_tool_use"),
    id: Type.String(),
    name: Type.String(),
    input: Type.Record(Type.String(), Type.Unknown()),
});
export const anthropicServerResultSchema = Type.Object({
    type: Type.String({ pattern: "_tool_result$" }),
    tool_use_id: Type.String(),
    content: Type.Optional(Type.Unknown()),
});

export function isAnthropicServerToolContinuation(vendor: unknown): boolean {
    return Value.Check(continuationMetadata, vendor);
}

export function anthropicServerToolOutput(vendor: unknown): unknown {
    if (!Value.Check(outputMetadata, vendor)) return undefined;
    try {
        return JSON.parse(vendor.outputBlock) as unknown;
    } catch {
        return undefined;
    }
}

/** Rebuild from caller-owned native blocks, never from a session-local history cache. */
export function pendingAnthropicServerTools(
    messages: readonly SessionMessage[],
): Map<string, SessionToolCallBlock> {
    const pending = new Map<string, SessionToolCallBlock>();
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
            if (block.type !== "tool_call" && block.type !== "tool_result") continue;
            const native = anthropicServerToolOutput(block.vendor);
            if (
                block.type === "tool_call" &&
                block.server === true &&
                block.incomplete !== true &&
                !isAnthropicServerToolContinuation(block.vendor) &&
                Value.Check(serverCall, native)
            ) {
                pending.set(block.callId, block);
            } else if (
                block.type === "tool_result" &&
                block.incomplete !== true &&
                Value.Check(anthropicServerResultSchema, native)
            ) {
                pending.delete(block.callId);
            }
        }
    }
    return pending;
}

/** Request-only projection of response-local continuation markers onto native call identities. */
export class AnthropicServerToolReplay {
    private readonly calls = new Map<string, unknown>();
    private readonly results = new Map<string, unknown>();
    private readonly continuations = new Set<string>();

    skip(block: SessionAssistantBlock): boolean {
        if (block.type !== "tool_call" && block.type !== "tool_result") return false;
        const continuation = isAnthropicServerToolContinuation(block.vendor);
        const native = anthropicServerToolOutput(block.vendor);
        if (
            block.type === "tool_call" &&
            block.server === true &&
            Value.Check(serverCall, native)
        ) {
            const call = { ...native, id: block.callId };
            if (continuation) {
                if (!isDeepStrictEqual(this.calls.get(block.callId), call)) {
                    throw new Error(
                        "Anthropic server-tool continuation has no matching native call.",
                    );
                }
                this.continuations.add(block.callId);
                return true;
            }
            this.calls.set(block.callId, call);
        } else if (
            block.type === "tool_result" &&
            Value.Check(anthropicServerResultSchema, native)
        ) {
            const result = { ...native, tool_use_id: block.callId };
            if (continuation) {
                if (!this.continuations.delete(block.callId)) {
                    throw new Error(
                        "Anthropic server-tool continuation result has no matching call.",
                    );
                }
                const previous = this.results.get(block.callId);
                if (previous !== undefined) {
                    // Completed blocks survive a caller's stream reset. A retry can therefore
                    // persist the same settlement again. Only an identical, explicitly marked
                    // continuation may be omitted; conflicting native results are never hidden.
                    if (!isDeepStrictEqual(previous, result)) {
                        throw new Error(
                            "Anthropic returned conflicting results for a server tool.",
                        );
                    }
                    return true;
                }
            }
            this.results.set(block.callId, result);
        } else if (continuation) {
            throw new Error(
                "Anthropic server-tool continuation is missing its native replay block.",
            );
        }
        return false;
    }
}
