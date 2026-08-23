import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { committedSessionEvents } from "@/core/committedSessionEvents.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";

describe("committedSessionEvents", () => {
    it("discards reset blocks and keeps committed blocks", () => {
        const events: SessionEvent[] = [
            { type: "block_start" },
            { type: "text_start" },
            { type: "text_delta", delta: "discarded" },
            { type: "text_end" },
            { type: "block_reset" },
            { type: "retrying", attempt: 1, reason: "retry" },
            { type: "block_start" },
            { type: "text_start" },
            { type: "text_delta", delta: "kept" },
            { type: "text_end" },
            { type: "block_stop" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ];

        expect(committedSessionEvents(events)).toEqual([
            { type: "retrying", attempt: 1, reason: "retry" },
            { type: "text_start" },
            { type: "text_delta", delta: "kept" },
            { type: "text_end" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ]);
    });

    it("discards an unterminated block", () => {
        expect(
            committedSessionEvents([
                { type: "block_start" },
                { type: "toolcall_delta", callId: "call", delta: '{"cmd":' },
            ]),
        ).toEqual([]);
    });

    it("rejects nested and unmatched block boundaries", () => {
        expect(() =>
            committedSessionEvents([{ type: "block_start" }, { type: "block_start" }]),
        ).toThrow("A session event block is already open.");
        expect(() => committedSessionEvents([{ type: "block_stop" }])).toThrow(
            "No session event block is open.",
        );
    });
});

describe("assistantMessageFromEvents", () => {
    it("reconstructs ordered blocks without indexes and rewinds failed attempts", () => {
        const events: SessionEvent[] = [
            { type: "block_start" },
            { type: "text_start" },
            { type: "text_delta", delta: "discarded" },
            { type: "text_end" },
            { type: "block_reset" },
            { type: "block_start" },
            { type: "reasoning_start" },
            { type: "reasoning_delta", delta: "Think." },
            { type: "reasoning_end", reasoning: "opaque" },
            { type: "text_start" },
            { type: "text_delta", delta: "Use it." },
            { type: "text_end" },
            {
                type: "toolcall_start",
                callId: "call-1",
                name: "read",
                vendor: { provider: "test" },
            },
            { type: "toolcall_delta", callId: "call-1", delta: '{"path":"x"}' },
            {
                type: "toolcall_end",
                callId: "call-1",
                arguments: '{"path":"x"}',
            },
            { type: "block_stop" },
            { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
        ];

        expect(assistantMessageFromEvents(events)).toEqual({
            role: "assistant",
            content: [
                { type: "reasoning", text: "Think.", reasoning: "opaque" },
                { type: "text", text: "Use it." },
                {
                    type: "tool_call",
                    callId: "call-1",
                    name: "read",
                    arguments: '{"path":"x"}',
                    vendor: { provider: "test", providerCallId: "call-1" },
                },
            ],
        });
    });
});
