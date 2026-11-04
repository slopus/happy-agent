import { describe, expect, it } from "vitest";

import {
    OpenAICompatibleProvider,
    assistantMessageFromEvents,
    committedSessionEvents,
    type SessionEvent,
} from "@/index.js";
import { testContext } from "./testContext.js";

/**
 * Gateways put the same Chat Completions stream on the wire in many shapes. Each case streams the
 * same three text deltas, a finish chunk, and a usage chunk, and must produce the same answer.
 */
const MODEL = "gateway/model";

function data(value: object): string {
    return `data: ${JSON.stringify(value)}`;
}
const text = (content: string) =>
    data({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const usage = data({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });
/** Some gateways report usage on the finish chunk instead of a separate one. */
const finishWithUsage = data({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
});
const answer = [text("O"), text("K"), text(".")];

function events(lines: readonly string[], eol = "\n"): string {
    return lines.map((line) => `${line}${eol}${eol}`).join("");
}

const cases: Readonly<Record<string, string>> = {
    "LF framing": events([...answer, finish, usage, "data: [DONE]"]),
    "CRLF framing": events([...answer, finish, usage, "data: [DONE]"], "\r\n"),
    "lone CR framing": events([...answer, finish, usage, "data: [DONE]"], "\r"),
    "a blank CRLF line after an LF line": [...answer, finish, usage, "data: [DONE]"]
        .map((line) => `${line}\n\r\n`)
        .join(""),
    "comments and event-only keepalives": events([
        ": connected",
        answer[0]!,
        ": keepalive",
        answer[1]!,
        "event: ping",
        answer[2]!,
        finish,
        usage,
        "data: [DONE]",
    ]),
    "a byte-order mark and data fields without a space": `\uFEFF${events(
        [...answer, finish, usage, "data: [DONE]"].map((line) => line.replace("data: ", "data:")),
    )}`,
    "one chunk split across data lines": events([
        `data: {"choices":[{"index":0,\ndata: "delta":{"content":"O"},"finish_reason":null}]}`,
        answer[1]!,
        answer[2]!,
        finish,
        usage,
        "data: [DONE]",
    ]),
    "empty choices and a delta-less finish": events([
        data({ choices: [] }),
        data({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
        ...answer,
        data({ choices: [{ index: 0, finish_reason: "stop" }] }),
        data({ usage: { prompt_tokens: 12, completion_tokens: 3 } }),
        "data: [DONE]",
    ]),
    "no [DONE] and no final blank line": `${events([...answer, finish])}${usage}`,
    "the finish chunk without a final newline": `${events(answer)}${finishWithUsage}`,
    "the finish chunk ending with a single CRLF": `${events(answer, "\r\n")}${finishWithUsage}\r\n`,
};

/** Every case is also delivered one byte, two bytes, and a few odd sizes at a time. */
const splits: Readonly<Record<string, readonly number[]>> = {
    "one read": [Number.MAX_SAFE_INTEGER],
    "one byte per read": [1],
    "two bytes per read": [2],
    "uneven reads": [3, 7, 1, 13],
};

function streamed(body: string, sizes: readonly number[]): Response {
    const bytes = new TextEncoder().encode(body);
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (let offset = 0, index = 0; offset < bytes.length; index++) {
                    const size = sizes[index % sizes.length]!;
                    controller.enqueue(bytes.slice(offset, offset + size));
                    offset += size;
                }
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream" } },
    );
}

async function run(response: () => Response): Promise<SessionEvent[]> {
    const provider = new OpenAICompatibleProvider({
        apiKey: "test-gateway-key",
        endpoint: "https://gateway.example/v1",
        vendor: "Gateway",
        models: [{ id: MODEL }],
        fetch: async () => response(),
        inferenceMaxRetries: 0,
    });
    const session = await provider.session("gateway", { instructions: "Reply with OK." });
    try {
        const events: SessionEvent[] = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "Reply with OK.",
                messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }],
            },
        }))
            events.push(event);
        return events;
    } finally {
        session.destroy();
    }
}

describe("OpenAI-compatible gateway streaming", () => {
    for (const [name, body] of Object.entries(cases)) {
        for (const [split, sizes] of Object.entries(splits)) {
            it(`keeps every chunk with ${name}, ${split}`, async () => {
                const events = await run(() => streamed(body, sizes));
                expect(events.at(-1)).toEqual({
                    type: "done",
                    state: "normal",
                    tokens: { input: 12, output: 3 },
                });
                expect(assistantMessageFromEvents(committedSessionEvents(events))?.content).toEqual(
                    [{ type: "text", text: "OK." }],
                );
            });
        }
    }

    it("keeps multibyte text split inside a character", async () => {
        const body = events([text("Привет 👋"), finish, usage, "data: [DONE]"]);
        const result = await run(() => streamed(body, [1]));
        expect(assistantMessageFromEvents(committedSessionEvents(result))?.content).toEqual([
            { type: "text", text: "Привет 👋" },
        ]);
    });

    it("ignores anything a gateway sends after [DONE]", async () => {
        const body = events([...answer, finish, usage, "data: [DONE]", text(" extra")]);
        const result = await run(() => streamed(body, [5]));
        expect(assistantMessageFromEvents(committedSessionEvents(result))?.content).toEqual([
            { type: "text", text: "OK." },
        ]);
    });

    it("reports an error the gateway sends inside the stream", async () => {
        const body = events([
            text("O"),
            data({ error: { message: "Upstream model overloaded.", type: "server_error" } }),
        ]);
        const result = await run(() => streamed(body, [4]));
        expect(result.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "Upstream model overloaded.",
        });
    });

    it("names the vendor when a chunk is not JSON", async () => {
        const result = await run(() => streamed(events(["data: {not json"]), [64]));
        expect(result.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "Gateway returned an invalid chat response chunk.",
        });
    });
});
