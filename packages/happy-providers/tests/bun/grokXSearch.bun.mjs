import assert from "node:assert/strict";

import { createRootContext } from "@steve.kite/stdlib";

import { GrokApiKeyCredential } from "../../sources/vendors/grok/GrokApiKeyCredential.ts";
import { GrokProvider } from "../../sources/vendors/grok/GrokProvider.ts";

const answer = "[Bun-compatible X post](https://x.com/happy/status/123)";
let receivedXSearch = false;
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const body = await request.json();
        receivedXSearch = body.tools?.some((tool) => tool.type === "x_search") === true;
        return new Response(
            [
                event({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_bun",
                        name: "x_keyword_search",
                        input: "",
                    },
                }),
                event({
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_bun",
                        name: "x_keyword_search",
                        input: '{"query":"Happy Agent"}',
                    },
                }),
                event({
                    type: "response.output_item.added",
                    output_index: 1,
                    item: { type: "message", id: "message_bun", role: "assistant", content: [] },
                }),
                event({ type: "response.output_text.delta", output_index: 1, delta: answer }),
                event({
                    type: "response.completed",
                    response: {
                        id: "response_bun",
                        output: [],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                }),
                "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
        );
    },
});

const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test-key" });
assert.notEqual(credential, null);
const provider = new GrokProvider({
    credential,
    endpoint: `http://127.0.0.1:${server.port}/v1`,
    model: "grok-4.5",
});
const session = await provider.session("bun-x-search", {
    instructions: "Search X.",
    tools: [{ name: "x_search", server: { type: "x_search" } }],
});

try {
    const events = [];
    for await (const item of session.run(createRootContext().named("bun-x-search"), {
        context: {
            instructions: "Search X.",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Find a recent Happy Agent post." }],
                },
            ],
        },
    })) {
        events.push(item);
    }

    assert.equal(receivedXSearch, true);
    assert.equal(
        events.some(
            (item) =>
                item.type === "toolcall_start" && item.callId === "xs_bun" && item.server === true,
        ),
        true,
    );
    assert.equal(
        events
            .filter((item) => item.type === "text_delta")
            .map((item) => item.delta)
            .join(""),
        answer,
    );
    assert.deepEqual(events.at(-1), {
        type: "done",
        state: "normal",
        tokens: { input: 1, output: 1 },
    });
} finally {
    await session.destroy();
    server.stop(true);
}

function event(value) {
    return `data: ${JSON.stringify(value)}\n\n`;
}
