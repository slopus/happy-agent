import { describe, expect, it } from "vitest";

import type {
    SessionAssistantMessage,
    SessionMessage,
    SessionToolCallBlock,
    SessionToolResultBlock,
} from "@/core/SessionContext.js";
import { pendingAnthropicServerTools } from "@/protocol/anthropic/anthropicServerToolContinuation.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";

const nativeCall = {
    type: "server_tool_use",
    id: "native-id",
    name: "tool_search_tool_regex",
    input: { pattern: "project" },
};
const nativeResult = {
    type: "tool_search_tool_result",
    tool_use_id: "native-id",
    content: { type: "tool_search_tool_search_result", tool_references: [] },
};
const call: SessionToolCallBlock = {
    type: "tool_call",
    callId: "native-id",
    name: "ToolSearch",
    server: true,
    arguments: JSON.stringify(nativeCall.input),
    vendor: { outputBlock: JSON.stringify(nativeCall) },
};
const continuation: SessionToolCallBlock = {
    ...call,
    vendor: { ...call.vendor, anthropicServerToolContinuation: true },
};
const result: SessionToolResultBlock = {
    type: "tool_result",
    callId: "native-id",
    content: [],
    vendor: { outputBlock: JSON.stringify(nativeResult), anthropicServerToolContinuation: true },
};
const assistant = (...content: SessionAssistantMessage["content"]): SessionAssistantMessage => ({
    role: "assistant",
    content,
});
const boundary: SessionMessage = {
    role: "tool",
    callId: "bash",
    content: [{ type: "text", text: "ok" }],
};

describe("Anthropic server-tool continuation replay", () => {
    it("projects durable settlements retained across a retry to exactly one native pair", () => {
        const messages = [
            assistant(call),
            boundary,
            assistant(continuation, result, continuation, result),
        ];
        const before = structuredClone(messages);
        const projected = toAnthropicMessages(messages);
        expect(projected[0]?.content).toEqual([nativeCall]);
        expect(projected[2]?.content).toEqual([nativeResult]);
        expect(messages).toEqual(before);
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
    });

    it("keeps a call pending when a response aborts before its result is complete", () => {
        const messages = [assistant(call), boundary, assistant(continuation)];
        expect(pendingAnthropicServerTools(messages).get(call.callId)).toEqual(call);
        expect(toAnthropicMessages(messages)).toHaveLength(2);
        expect(
            pendingAnthropicServerTools([...messages, assistant({ ...result, incomplete: true })])
                .size,
        ).toBe(1);
        expect(pendingAnthropicServerTools([...messages, assistant(result)]).size).toBe(0);
    });

    it("uses caller-supplied identities rather than stale IDs in opaque native blocks", () => {
        const messages = [
            assistant({ ...call, callId: "replacement" }),
            boundary,
            assistant(
                { ...continuation, callId: "replacement" },
                { ...result, callId: "replacement" },
            ),
        ];
        const wire = toAnthropicMessages(messages);
        expect(wire[0]?.content).toEqual([{ ...nativeCall, id: "replacement" }]);
        expect(wire[2]?.content).toEqual([{ ...nativeResult, tool_use_id: "replacement" }]);
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
    });

    it("rejects an unanchored continuation instead of silently dropping a native call", () => {
        expect(() => toAnthropicMessages([assistant(continuation, result)])).toThrow(
            "no matching native call",
        );
    });

    it("rejects conflicting duplicate settlements rather than hiding changed results", () => {
        const conflicting: SessionToolResultBlock = {
            ...result,
            vendor: {
                ...result.vendor,
                outputBlock: JSON.stringify({ ...nativeResult, content: "different" }),
            },
        };
        expect(() =>
            toAnthropicMessages([
                assistant(call),
                boundary,
                assistant(continuation, result, continuation, conflicting),
            ]),
        ).toThrow("conflicting results");
    });

    it("does not treat client tools, incomplete calls, or arbitrary metadata as pending server work", () => {
        const { server: _server, ...clientCall } = call;
        expect(
            pendingAnthropicServerTools([
                assistant(clientCall),
                assistant({ ...call, incomplete: true }),
                assistant({ ...call, vendor: { outputBlock: "not json" } }),
            ]).size,
        ).toBe(0);
    });
});
