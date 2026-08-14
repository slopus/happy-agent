import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import {
    AnthropicRefusalError,
    isAnthropicRefusalError,
} from "@/protocol/anthropic/AnthropicRefusalError.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";

describe("Anthropic protocol stop reasons", () => {
    it.each([
        ["pause_turn", { type: "done", state: "normal" }],
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

    it("throws a refusal with its stop_details so the session can retry it", async () => {
        const error = await collectUntilThrow(
            mapAnthropicStream(
                streamEndingWith("refusal", 1, {
                    type: "refusal",
                    category: "cyber",
                    explanation: "The response was flagged by a safety classifier.",
                }),
            ),
        );

        expect(isAnthropicRefusalError(error)).toBe(true);
        const refusal = error as AnthropicRefusalError;
        expect(refusal.category).toBe("cyber");
        expect(refusal.explanation).toBe("The response was flagged by a safety classifier.");
        expect(refusal.message).toBe(
            "The model refused to complete the request (category: cyber): " +
                "The response was flagged by a safety classifier.",
        );
        expect(refusal.usage).toMatchObject({ output: 1 });
    });

    it("throws a readable refusal when stop_details is absent", async () => {
        const error = await collectUntilThrow(mapAnthropicStream(streamEndingWith("refusal")));

        expect(isAnthropicRefusalError(error)).toBe(true);
        expect((error as AnthropicRefusalError).message).toBe(
            "The model refused to complete the request.",
        );
    });

    it("keeps a zero-token refusal a refusal instead of an empty response", async () => {
        const error = await collectUntilThrow(mapAnthropicStream(streamEndingWith("refusal", 0)));

        expect(isAnthropicRefusalError(error)).toBe(true);
    });

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

async function collectUntilThrow(stream: AsyncGenerator<SessionEvent>): Promise<unknown> {
    try {
        for await (const event of stream) void event;
    } catch (error) {
        return error;
    }
    throw new Error("Expected the stream to throw.");
}

async function* streamEndingWith(
    stopReason: "pause_turn" | "refusal" | "compaction",
    outputTokens = 1,
    stopDetails?: { type: "refusal"; category: string | null; explanation: string | null },
): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield {
        type: "message_start",
        message: {
            usage: { input_tokens: 1, output_tokens: 0 },
        },
    } as BetaRawMessageStreamEvent;
    yield {
        type: "message_delta",
        delta: {
            stop_reason: stopReason,
            stop_sequence: null,
            ...(stopDetails === undefined ? {} : { stop_details: stopDetails }),
        },
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
