import { describe, expect, it } from "vitest";

import { createGym, type HttpResponseReplacement } from "@slopus/happy-terminal-gym";

describe("Fable 5.1 large-context continuation", () => {
    it("continues after the SDK measures a context above 200k without showing a false overflow", async () => {
        let requests = 0;
        const gym = await createGym({
            mode: "docker",
            providerId: "claude",
            modelId: "anthropic/fable-5-1",
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: "http://api.anthropic.test",
            },
            httpProxy: {
                handler(request) {
                    if (
                        request.method === "POST" &&
                        new URL(request.url).pathname === "/v1/messages"
                    ) {
                        expect(Buffer.from(request.body).toString()).toContain("claude-fable-5-1");
                        requests += 1;
                        return {
                            response: responseFor(
                                requests === 1 ? "LARGE_CONTEXT_READY" : "LARGE_CONTEXT_CONTINUED",
                            ),
                        };
                    }
                    return {
                        response: {
                            status: 404,
                            body: "Only scripted model requests are allowed.",
                        },
                    };
                },
            },
            timeoutMs: 30_000,
        });
        try {
            gym.terminal.type("Start the large-context conversation.");
            gym.terminal.press("enter");
            await gym.terminal.waitUntil(
                (screen) =>
                    screen.text.includes("LARGE_CONTEXT_READY") &&
                    screen.text.includes("Ask Happy Terminal to do anything") &&
                    !screen.text.includes("esc to interrupt"),
                "the first turn to finish with 235k tokens of provider-reported context",
                30_000,
            );
            gym.terminal.type("Continue the same conversation.");
            gym.terminal.press("enter");
            const screen = await gym.terminal.waitForText("LARGE_CONTEXT_CONTINUED", 30_000);
            expect(screen.text).not.toContain("Prompt is too long");
            expect(requests).toBe(2);
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});

function responseFor(text: string): HttpResponseReplacement {
    const events = [
        {
            type: "message_start",
            message: {
                id: `msg_${text}`,
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 235_170,
                    output_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
    ];
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
    };
}
