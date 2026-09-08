import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";

describe("Anthropic protocol stop reasons", () => {
    it.each([
        ["pause_turn", { type: "done", state: "normal" }],
        [
            "refusal",
            {
                type: "done",
                state: "error",
                message: "The model refused to complete the request.",
            },
        ],
        [
            "compaction",
            {
                type: "done",
                state: "error",
                message: "Anthropic returned an unexpected compaction response during inference.",
            },
        ],
    ] as const)("maps %s explicitly", async (stopReason, expected) => {
        const events: SessionEvent[] = [];
        for await (const event of mapAnthropicStream(streamEndingWith(stopReason))) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject(expected);
    });

    it("keeps a zero-token refusal terminal instead of retrying it as empty", async () => {
        const events: SessionEvent[] = [];
        for await (const event of mapAnthropicStream(streamEndingWith("refusal", 0))) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "The model refused to complete the request.",
        });
    });

    it.each(["start", "delta"] as const)(
        "surfaces structured refusal details from message_%s",
        async (eventType) => {
            const events: SessionEvent[] = [];
            for await (const event of mapAnthropicStream(refusalDetailStream(eventType))) {
                events.push(event);
            }

            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message:
                    "The model refused to complete the request under its cybersecurity safety policy: The request combined broad shell access with credential operations.",
            });
        },
    );

    it.each(["start", "delta"] as const)(
        "fails a paused compaction from a %s event instead of completing an empty response",
        async (eventType) => {
            const events: SessionEvent[] = [];
            for await (const event of mapAnthropicStream(pausedCompactionStream(eventType))) {
                events.push(event);
            }

            expect(events.some((event) => event.type === "text_start")).toBe(false);
            expect(events.at(-1)).toEqual({
                type: "done",
                state: "error",
                kind: "unknown",
                message: "Anthropic returned an unexpected compaction response during inference.",
                providerError: { type: "unclassified" },
            });
        },
    );
});

async function* streamEndingWith(
    stopReason: "pause_turn" | "refusal" | "compaction",
    outputTokens = 1,
): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield {
        type: "message_start",
        message: {
            usage: { input_tokens: 1, output_tokens: 0 },
        },
    } as BetaRawMessageStreamEvent;
    yield {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
    } as BetaRawMessageStreamEvent;
    yield { type: "message_stop" } as BetaRawMessageStreamEvent;
}

async function* pausedCompactionStream(
    eventType: "start" | "delta",
): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield {
        type: "message_start",
        message: {
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 50_480 },
        },
    } as BetaRawMessageStreamEvent;
    if (eventType === "start") {
        yield {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "compaction",
                content: null,
                encrypted_content: null,
            },
        } as BetaRawMessageStreamEvent;
        yield { type: "content_block_stop", index: 0 } as BetaRawMessageStreamEvent;
    } else {
        yield {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "compaction_delta",
                content: "replacement",
                encrypted_content: "opaque",
            },
        } as BetaRawMessageStreamEvent;
    }
    yield {
        type: "message_delta",
        delta: { stop_reason: "pause_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
    } as BetaRawMessageStreamEvent;
    yield { type: "message_stop" } as BetaRawMessageStreamEvent;
}

async function* refusalDetailStream(
    eventType: "start" | "delta",
): AsyncGenerator<BetaRawMessageStreamEvent> {
    const stopDetails = {
        category: "cyber",
        explanation: "The request combined broad shell access with credential operations.",
        fallback_credit_token: null,
    };
    yield {
        type: "message_start",
        message: {
            stop_details: eventType === "start" ? stopDetails : null,
            usage: { input_tokens: 1, output_tokens: 0 },
        },
    } as BetaRawMessageStreamEvent;
    yield {
        type: "message_delta",
        delta: {
            stop_details: eventType === "delta" ? stopDetails : null,
            stop_reason: "refusal",
            stop_sequence: null,
        },
        usage: { output_tokens: 1 },
    } as BetaRawMessageStreamEvent;
    yield { type: "message_stop" } as BetaRawMessageStreamEvent;
}
