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
    it("omits an abandoned native search when a new user turn resumes the conversation", () => {
        const messages: SessionMessage[] = [
            { role: "user", content: [{ type: "text", text: "Find a tool." }] },
            assistant(call, { type: "text", text: "Search was interrupted." }),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        const before = structuredClone(messages);
        expect(toAnthropicMessages(messages)[1]?.content).toEqual([
            { type: "text", text: "Search was interrupted." },
        ]);
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
        expect(messages).toEqual(before);
    });

    it("preserves a completed native search even when another search was abandoned", () => {
        const completedCall = { ...call, callId: "completed" };
        const completedResult = {
            ...result,
            callId: "completed",
            vendor: {
                outputBlock: JSON.stringify(nativeResult),
            },
        };
        const messages: SessionMessage[] = [
            assistant(call, completedCall, completedResult),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        expect(toAnthropicMessages(messages)[0]?.content).toEqual([
            { ...nativeCall, id: "completed" },
            { ...nativeResult, tool_use_id: "completed" },
        ]);
    });

    it("omits an empty assistant turn left by an abandoned search", () => {
        const messages: SessionMessage[] = [
            { role: "user", content: [{ type: "text", text: "Find a tool." }] },
            assistant(call),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        expect(toAnthropicMessages(messages).map((message) => message.role)).toEqual([
            "user",
            "user",
        ]);
    });

    it("retains a real delayed settlement even if a user message intervened", () => {
        const messages: SessionMessage[] = [
            assistant(call),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
            assistant(continuation, result),
        ];
        const before = structuredClone(messages);
        expect(toAnthropicMessages(messages)[0]?.content).toEqual([nativeCall]);
        expect(toAnthropicMessages(messages)[2]?.content).toEqual([nativeResult]);
        expect(messages).toEqual(before);
    });

    it("omits an abandoned search when a message from another agent starts new work", () => {
        const messages: SessionMessage[] = [
            assistant(call, { type: "text", text: "Saved prefix." }),
            {
                role: "agent",
                author: { id: "bootstrap", description: "Bootstrap projects" },
                content: [{ type: "text", text: "Continue bootstrapping." }],
            },
        ];
        expect(toAnthropicMessages(messages)[0]?.content).toEqual([
            { type: "text", text: "Saved prefix." },
        ]);
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
    });

    it("does not replay an incomplete native result when abandoning its search", () => {
        const messages: SessionMessage[] = [
            assistant(call, { ...result, incomplete: true }),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        const before = structuredClone(messages);
        expect(toAnthropicMessages(messages)).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: "Continue.", cache_control: { type: "ephemeral" } },
                ],
            },
        ]);
        expect(messages).toEqual(before);
    });

    it.each(["user", "agent", "system"] as const)(
        "ends the pending server continuation when %s input follows client results",
        (role) => {
            const clientCall: SessionToolCallBlock = {
                type: "tool_call",
                callId: boundary.callId,
                name: "Bash",
                arguments: "{}",
            };
            const input: SessionMessage =
                role !== "agent"
                    ? { role, content: [{ type: "text", text: "Also inspect projects." }] }
                    : {
                          role,
                          author: { id: "bootstrap", description: "Bootstrap projects" },
                          content: [{ type: "text", text: "Also inspect projects." }],
                      };
            const messages = [assistant(clientCall, call), boundary, input];
            const before = structuredClone(messages);
            expect(pendingAnthropicServerTools(messages).size).toBe(0);
            expect(toAnthropicMessages(messages)[0]?.content).toEqual([
                { type: "tool_use", id: boundary.callId, name: "Bash", input: {} },
            ]);
            expect(messages).toEqual(before);
        },
    );

    it("omits a canceled search even when its local call was settled as an error", () => {
        const messages: SessionMessage[] = [
            assistant(
                { type: "tool_call", callId: boundary.callId, name: "Bash", arguments: "{}" },
                call,
            ),
            { ...boundary, isError: true },
            { role: "user", content: [{ type: "text", text: "Handle this immediately." }] },
        ];
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
        expect(toAnthropicMessages(messages)[0]?.content).not.toContainEqual(nativeCall);
        expect(toAnthropicMessages(messages)[1]?.content).toEqual([
            {
                type: "tool_result",
                tool_use_id: boundary.callId,
                content: "ok",
                is_error: true,
            },
        ]);
    });

    it("does not mistake an unrelated tool result for a live search continuation", () => {
        const messages: SessionMessage[] = [
            assistant(call),
            boundary,
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
        expect(toAnthropicMessages(messages).some((message) => message.role === "assistant")).toBe(
            false,
        );
    });

    it("abandons a search left behind after its client-tool continuation returned a newer response", () => {
        const messages: SessionMessage[] = [
            assistant(
                { type: "tool_call", callId: boundary.callId, name: "Bash", arguments: "{}" },
                call,
            ),
            boundary,
            assistant({ type: "text", text: "The later response finished." }),
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ];
        expect(pendingAnthropicServerTools(messages).size).toBe(0);
        expect(toAnthropicMessages(messages)[0]?.content).not.toContainEqual(nativeCall);
    });

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
