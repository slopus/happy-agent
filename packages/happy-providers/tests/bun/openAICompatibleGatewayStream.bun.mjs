import assert from "node:assert/strict";

import { createRootContext } from "@steve.kite/stdlib";

import { OpenAICompatibleProvider } from "../../sources/vendors/openaiCompatible/OpenAICompatibleProvider.ts";

// A fast gateway answer arrives in a few coalesced reads. On Bun this must still yield every delta,
// in CRLF and LF framing, whether the body is written at once or one event at a time.
const deltas = Array.from({ length: 60 }, (_, index) => `t${index} `);

function body(eol) {
    const chunks = [
        ...Array.from({ length: 10 }, (_, index) => ({
            choices: [{ index: 0, delta: { reasoning_content: `r${index}` }, finish_reason: null }],
        })),
        ...deltas.map((content) => ({
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })),
        {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 70 },
        },
    ];
    return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].map(
        (event) => `${event}${eol}${eol}`,
    );
}

let shape = { eol: "\n", coalesced: true };
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
        const events = body(shape.eol);
        const encoder = new TextEncoder();
        const stream = shape.coalesced
            ? events.join("")
            : new ReadableStream({
                  start(controller) {
                      for (const event of events) controller.enqueue(encoder.encode(event));
                      controller.close();
                  },
              });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
});

const ctx = createRootContext();
try {
    const provider = new OpenAICompatibleProvider({
        apiKey: "test-gateway-key",
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        vendor: "Gateway",
        models: [{ id: "gateway/model" }],
        inferenceMaxRetries: 0,
    });
    for (const eol of ["\n", "\r\n"]) {
        for (const coalesced of [true, false]) {
            shape = { eol, coalesced };
            for (let attempt = 0; attempt < 20; attempt++) {
                const session = await provider.session("bun-gateway", { instructions: "OK" });
                let text = "";
                let done;
                for await (const event of session.run(ctx, {
                    context: {
                        instructions: "OK",
                        messages: [{ role: "user", content: [{ type: "text", text: "OK" }] }],
                    },
                })) {
                    if (event.type === "text_delta") text += event.delta;
                    if (event.type === "done") done = event;
                }
                session.destroy();
                const label = `${JSON.stringify(eol)} ${coalesced ? "coalesced" : "per event"}`;
                assert.equal(text, deltas.join(""), label);
                assert.deepEqual(done, {
                    type: "done",
                    state: "normal",
                    tokens: { input: 10, output: 70 },
                });
            }
        }
    }
} finally {
    server.stop(true);
}
