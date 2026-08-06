import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { committedSessionEvents } from "@/core/committedSessionEvents.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokConnection } from "@/vendors/grok/impl/GrokConnection.js";

describe("Grok user agent", () => {
    it("retries a completed response with zero output tokens", async () => {
        let attempts = 0;
        const server = createServer((request, response) => {
            request.resume();
            request.once("end", () => {
                attempts += 1;
                if (attempts === 1) {
                    completeSse(response, "", 0);
                    return;
                }
                if (attempts === 2) {
                    completeSse(response, "discarded", 0);
                    return;
                }
                completeSse(response, "recovered", 1);
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing Grok test server port.");
        }
        const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "grok-empty-key" });
        if (credential === null) throw new Error("Expected a Grok test credential.");
        const provider = new GrokProvider({
            credential,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            model: "grok-4.5",
            waitForInferenceRetry: async () => {},
        });
        const session = await provider.session("empty-output-session", {
            instructions: "",
            tools: [],
        });
        const rebuild = vi.spyOn(GrokConnection.prototype, "rebuild");

        try {
            const events: SessionEvent[] = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "Retry empty output." }] },
            })) {
                events.push(event);
            }

            expect(attempts).toBe(3);
            expect(events).toContainEqual({
                type: "retrying",
                attempt: 1,
                reason: "Grok returned a response with zero output tokens.",
            });
            expect(events.filter((event) => event.type === "token_usage")).toEqual([
                {
                    type: "token_usage",
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 1,
                        output: 0,
                        totalTokens: 1,
                    },
                },
                {
                    type: "token_usage",
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 1,
                        output: 0,
                        totalTokens: 1,
                    },
                },
                {
                    type: "token_usage",
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 1,
                        output: 1,
                        totalTokens: 2,
                    },
                },
            ]);
            expect(
                committedSessionEvents(events)
                    .filter((event) => event.type === "text_delta")
                    .map((event) => event.delta)
                    .join(""),
            ).toBe("recovered");
            expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
            expect(rebuild).not.toHaveBeenCalled();
        } finally {
            rebuild.mockRestore();
            session.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("keeps every usage sample and valid block framing when empty retries exhaust", async () => {
        let attempts = 0;
        const server = createServer((request, response) => {
            request.resume();
            request.once("end", () => {
                attempts += 1;
                completeSse(response, attempts === 1 ? "" : "discarded", 0);
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing Grok test server port.");
        }
        const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "grok-empty-key" });
        if (credential === null) throw new Error("Expected a Grok test credential.");
        const provider = new GrokProvider({
            credential,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            inferenceMaxRetries: 1,
            model: "grok-4.5",
            waitForInferenceRetry: async () => {},
        });
        const session = await provider.session("empty-output-exhaustion", {
            instructions: "",
            tools: [],
        });

        try {
            const events: SessionEvent[] = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "Keep trying." }] },
            })) {
                events.push(event);
            }

            expect(attempts).toBe(2);
            expect(events.filter((event) => event.type === "token_usage")).toHaveLength(2);
            expect(() => committedSessionEvents(events)).not.toThrow();
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                providerError: {
                    type: "empty_response",
                    diagnostics: { attempts: 2 },
                },
            });
        } finally {
            session.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("reproduces the grok-shell user agent when the caller does not identify itself", async () => {
        const headers = await runOnce({});

        expect(headers?.["user-agent"]).toMatch(/^grok-shell\/\S+ \(.+; .+\)$/);
    });

    it("identifies the caller when it supplies a user agent", async () => {
        const headers = await runOnce({ userAgent: "rig/1.2.3" });

        expect(headers?.["user-agent"]).toBe("rig/1.2.3");
    });
});

async function runOnce(options: {
    userAgent?: string;
}): Promise<IncomingMessage["headers"] | undefined> {
    let headers: IncomingMessage["headers"] | undefined;
    const server = createServer((request, response) => {
        headers = request.headers;
        request.resume();
        request.once("end", () => completeSse(response));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Grok test server port.");
    }
    const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "grok-user-agent-key" });
    if (credential === null) throw new Error("Expected a Grok test credential.");
    const provider = new GrokProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: "grok-4.5",
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    });
    const session = await provider.session("user-agent-session", {
        instructions: "",
        tools: [],
    });
    try {
        for await (const _event of session.run({
            context: { messages: [{ role: "user", content: "Hello." }] },
        })) {
            // Draining the stream is what performs the request under test.
        }
    } finally {
        session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return headers;
}

function completeSse(response: ServerResponse, text = "", outputTokens = 1): void {
    const output =
        text.length === 0
            ? []
            : [
                  {
                      type: "message",
                      id: "message",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text, annotations: [] }],
                  },
              ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        [
            ...(text.length === 0
                ? []
                : [
                      {
                          type: "response.output_item.added",
                          output_index: 0,
                          item: { ...output[0], content: [] },
                      },
                      {
                          type: "response.output_text.delta",
                          output_index: 0,
                          content_index: 0,
                          delta: text,
                      },
                      {
                          type: "response.output_item.done",
                          output_index: 0,
                          item: output[0],
                      },
                  ]),
            {
                type: "response.completed",
                response: {
                    id: "response",
                    output,
                    usage: {
                        input_tokens: 1,
                        output_tokens: outputTokens,
                        total_tokens: 1 + outputTokens,
                    },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
}
