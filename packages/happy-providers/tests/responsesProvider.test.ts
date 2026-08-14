import { testContext, testContextWith } from "./testContext.js";

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { createOpenAIResponseRequest } from "@/protocol/responses/createOpenAIResponseRequest.js";
import { isTransientResponsesError } from "@/protocol/responses/responsesRetry.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

describe("ResponsesProvider", () => {
    it("retries a completed response with zero output tokens", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return sseResponse(
                    attempts === 1
                        ? [completedResponse([], 0)]
                        : [
                              {
                                  type: "response.output_item.added",
                                  output_index: 0,
                                  item: {
                                      type: "message",
                                      id: "message-recovered",
                                      role: "assistant",
                                      content: [],
                                  },
                              },
                              {
                                  type: "response.output_text.delta",
                                  output_index: 0,
                                  content_index: 0,
                                  delta: "recovered",
                              },
                              completedResponse(
                                  [
                                      {
                                          type: "message",
                                          id: "message-recovered",
                                          role: "assistant",
                                          status: "completed",
                                          content: [
                                              {
                                                  type: "output_text",
                                                  text: "recovered",
                                                  annotations: [],
                                              },
                                          ],
                                      },
                                  ],
                                  1,
                              ),
                          ],
                );
            },
        });
        const session = await provider.session("responses-empty-retry", {
            instructions: "",
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "Be concise.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Try again if empty." }],
                        },
                    ],
                },
            }),
        );

        expect(attempts).toBe(2);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: "Responses API returned a response with zero output tokens.",
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
                    output: 1,
                    totalTokens: 2,
                },
            },
        ]);
        expect(textFromSessionEvents(events)).toBe("recovered");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("preserves diagnostics when zero-output retries are exhausted", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return sseResponse([completedResponse([], 0)]);
            },
        });
        const session = await provider.session("responses-empty-exhausted", {
            instructions: "",
            tools: [],
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Keep trying." }],
                    },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(11);
        expect(events.filter((event) => event.type === "token_usage")).toHaveLength(11);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "Responses API returned a response with zero output tokens.",
            providerError: {
                type: "empty_response",
                diagnostics: {
                    attempts: 11,
                    code: "empty_response",
                    errorType: "empty_response",
                    upstreamMessage: "Responses API returned a response with zero output tokens.",
                },
            },
        });
    });

    it("does not interpret missing usage as zero output", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                attempts += 1;
                return sseResponse([
                    {
                        type: "response.completed",
                        response: { id: "response-without-usage", output: [] },
                    },
                ]);
            },
        });
        const session = await provider.session("responses-missing-usage", {
            instructions: "",
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "Be concise.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Usage may be absent." }],
                        },
                    ],
                },
            }),
        );

        expect(attempts).toBe(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("preserves a completed response that requests another inference", async () => {
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () =>
                sseResponse([
                    {
                        type: "response.completed",
                        response: {
                            id: "response-continue",
                            end_turn: false,
                            output: [],
                        },
                    },
                ]),
        });
        const session = await provider.session("responses-end-turn", {
            instructions: "",
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "Be concise.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Keep working." }],
                        },
                    ],
                },
            }),
        );

        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal", endTurn: false });
    });

    it("runs the standard Responses SSE protocol with configured endpoint and model", async () => {
        let requestBody: unknown;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async (_input, init) => {
                requestBody = JSON.parse(String(init?.body));
                return sseResponse([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "message-1", role: "assistant", content: [] },
                    },
                    {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        delta: "protocol ok",
                    },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "message",
                            id: "message-1",
                            role: "assistant",
                            status: "completed",
                            content: [
                                { type: "output_text", text: "protocol ok", annotations: [] },
                            ],
                        },
                    },
                    {
                        type: "response.completed",
                        response: {
                            id: "response-1",
                            output: [
                                {
                                    type: "message",
                                    id: "message-1",
                                    role: "assistant",
                                    status: "completed",
                                    content: [
                                        {
                                            type: "output_text",
                                            text: "protocol ok",
                                            annotations: [],
                                        },
                                    ],
                                },
                            ],
                            usage: {
                                input_tokens: 10,
                                input_tokens_details: { cached_tokens: 2 },
                                output_tokens: 3,
                                output_tokens_details: { reasoning_tokens: 0 },
                                total_tokens: 13,
                            },
                        },
                    },
                ]);
            },
        });
        const session = await provider.session("responses-session", {
            instructions: "Be concise.",
            tools: [
                {
                    name: "lookup",
                    description: "Look something up.",
                    parameters: Type.Object({ query: Type.String() }),
                },
            ],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "Be concise.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Check the protocol." }],
                        },
                    ],
                },
            }),
        );

        expect(textFromSessionEvents(events)).toBe("protocol ok");
        expect(events.at(-2)).toEqual({ type: "block_stop" });
        expect(events.some((event) => event.type === "done" && event.state === "normal")).toBe(
            true,
        );
        expect(requestBody).toMatchObject({
            model: "open-model",
            stream: true,
            store: false,
            instructions: "Be concise.",
            input: [{ role: "user", content: "Check the protocol." }],
            tools: [
                {
                    type: "function",
                    name: "lookup",
                    description: "Look something up.",
                    parameters: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                    },
                },
            ],
        });
        expect(requestBody).not.toHaveProperty("parallel_tool_calls");
        expect(requestBody).not.toHaveProperty("text");
    });

    it("configures optional request features through capabilities", () => {
        const request = createOpenAIResponseRequest({
            capabilities: {
                encryptedReasoning: false,
                parallelToolCalls: true,
                reasoning: true,
                textVerbosity: false,
            },
            context: {
                instructions: "Be concise.",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Hello." }],
                    },
                ],
            },
            effort: "high",
            model: "open-model",
        });

        expect(request.parallel_tool_calls).toBe(true);
        expect(request.text).toBeUndefined();
        expect(request.reasoning).toEqual({ effort: "high" });
        expect(request.include).toBeUndefined();
    });

    it("uses the native Responses compact endpoint and preserves its opaque item", async () => {
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async (input) => {
                expect(String(input)).toContain("/responses/compact");
                return Response.json({
                    id: "compacted-response-1",
                    object: "response.compaction",
                    created_at: 1,
                    output: [
                        {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: "Provider kept this." }],
                        },
                        {
                            id: "compaction-1",
                            type: "compaction",
                            encrypted_content: "opaque-checkpoint",
                        },
                    ],
                    usage: {
                        input_tokens: 20,
                        input_tokens_details: { cached_tokens: 5 },
                        output_tokens: 4,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 24,
                    },
                });
            },
        });
        const session = await provider.session("responses-compaction", {
            instructions: "Preserve state.",
            tools: [],
        });

        await expect(
            session.compact(testContext, {
                context: {
                    instructions: "Preserve state.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Provider dropped this." }],
                        },
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Provider kept this." }],
                        },
                    ],
                },
            }),
        ).resolves.toMatchObject({
            status: "completed",
            compaction: {
                role: "compaction",
                content: null,
                encryptedContent: "opaque-checkpoint",
                vendor: { type: "responses_compaction", id: "compaction-1" },
            },
            preservedMessages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Provider kept this." }],
                },
            ],
            usage: {
                input: 20,
                output: 4,
                cacheRead: 5,
                totalTokens: 24,
            },
        });
    });

    it("emits nothing when inference is already aborted", async () => {
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                throw new Error("A pre-aborted run must not reach the network.");
            },
        });
        const session = await provider.session("responses-aborted", {
            instructions: "",
            tools: [],
        });
        const controller = new AbortController();
        controller.abort();
        const events = [];

        for await (const event of session.run(testContextWith(controller.signal), {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Do not send." }],
                    },
                ],
            },
        })) {
            events.push(event);
        }

        expect(events).toEqual([]);
    });

    it("retries a transient 500 failure and completes", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                if (attempts === 1) {
                    return Response.json(
                        { error: { message: "The server had an error." } },
                        { status: 500 },
                    );
                }
                return sseResponse([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "message-1", role: "assistant", content: [] },
                    },
                    {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        delta: "recovered",
                    },
                    completedResponse(
                        [
                            {
                                type: "message",
                                id: "message-1",
                                role: "assistant",
                                status: "completed",
                                content: [
                                    { type: "output_text", text: "recovered", annotations: [] },
                                ],
                            },
                        ],
                        1,
                    ),
                ]);
            },
        });
        const session = await provider.session("responses-transient-retry", {
            instructions: "",
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        { role: "user", content: [{ type: "text" as const, text: "Retry once." }] },
                    ],
                },
            }),
        );

        expect(attempts).toBe(2);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(textFromSessionEvents(events)).toBe("recovered");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("honors a zero transient retry budget set on the session", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "The server had an error." } },
                    { status: 500 },
                );
            },
        });
        const session = await provider.session("responses-transient-budget", {
            instructions: "",
            tools: [],
            inferenceMaxRetries: 0,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    { role: "user", content: [{ type: "text" as const, text: "Fail once." }] },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "internal_server_error" },
        });
    });

    it("does not retry a 401 by default", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                attempts += 1;
                return Response.json({ error: { message: "Invalid API key." } }, { status: 401 });
            },
        });
        const session = await provider.session("responses-auth-fatal", {
            instructions: "",
            tools: [],
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    { role: "user", content: [{ type: "text" as const, text: "Auth please." }] },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "authentication" },
        });
    });

    it("retries a 401 once under a fatal retry budget and can succeed", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                if (attempts === 1) {
                    return Response.json(
                        { error: { message: "Invalid API key." } },
                        { status: 401 },
                    );
                }
                return sseResponse([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "message-1", role: "assistant", content: [] },
                    },
                    {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        delta: "recovered",
                    },
                    completedResponse(
                        [
                            {
                                type: "message",
                                id: "message-1",
                                role: "assistant",
                                status: "completed",
                                content: [
                                    { type: "output_text", text: "recovered", annotations: [] },
                                ],
                            },
                        ],
                        1,
                    ),
                ]);
            },
        });
        const session = await provider.session("responses-auth-fatal-retry", {
            instructions: "",
            tools: [],
            inferenceFatalRetries: 1,
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        { role: "user", content: [{ type: "text" as const, text: "Auth please." }] },
                    ],
                },
            }),
        );

        expect(attempts).toBe(2);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 1,
            reason: expect.stringContaining("attempt 1 of 1"),
        });
        expect(textFromSessionEvents(events)).toBe("recovered");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("does not retry a spent-account 429 as transient", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "You exceeded your quota.", code: "insufficient_quota" } },
                    { status: 429 },
                );
            },
        });
        const session = await provider.session("responses-quota-fatal", {
            instructions: "",
            tools: [],
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Spend it." }] }],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "billing_error",
            providerError: { type: "out_of_tokens" },
        });
    });

    it("retries a spent-account 429 under a fatal retry budget", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "You exceeded your quota.", code: "insufficient_quota" } },
                    { status: 429 },
                );
            },
        });
        const session = await provider.session("responses-quota-fatal-retry", {
            instructions: "",
            tools: [],
            inferenceFatalRetries: 1,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Spend it." }] }],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(2);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "billing_error",
            providerError: { type: "out_of_tokens" },
        });
    });

    it("never retries a context overflow that arrives as a 429", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "Your input exceeds the model's context window." } },
                    { status: 429 },
                );
            },
        });
        const session = await provider.session("responses-overflow-429", {
            instructions: "",
            tools: [],
            inferenceMaxRetries: 5,
            inferenceFatalRetries: 5,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    { role: "user", content: [{ type: "text" as const, text: "Send too much." }] },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
        });
    });

    it("never retries context overflow even with both budgets set", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "Maximum context_length exceeded." } },
                    { status: 413 },
                );
            },
        });
        const session = await provider.session("responses-context-overflow", {
            instructions: "",
            tools: [],
            inferenceMaxRetries: 5,
            inferenceFatalRetries: 5,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    { role: "user", content: [{ type: "text" as const, text: "Send too much." }] },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
        });
    });

    it("never retries a context overflow that claims to be retryable", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "Your input exceeds the model's context window." } },
                    { status: 400, headers: { "x-should-retry": "true" } },
                );
            },
        });
        const session = await provider.session("responses-overflow-retry-header", {
            instructions: "",
            tools: [],
            inferenceMaxRetries: 5,
            inferenceFatalRetries: 5,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    { role: "user", content: [{ type: "text" as const, text: "Send too much." }] },
                ],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
        });
    });

    it("never spends the fatal budget on an abort-shaped failure", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                // The transport surfaces this wrapped in an APIConnectionError, which would
                // otherwise be transient; the abort in its cause chain must win.
                throw Object.assign(new Error("Request was aborted."), {
                    name: "APIUserAbortError",
                });
            },
        });
        const session = await provider.session("responses-abort-shaped", {
            instructions: "",
            tools: [],
            inferenceFatalRetries: 3,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Stop." }] }],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
    });

    it("lets a session override outrank the provider's fatal budget", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            inferenceFatalRetries: 1,
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json({ error: { message: "Invalid API key." } }, { status: 401 });
            },
        });
        const session = await provider.session("responses-session-fatal-override", {
            instructions: "",
            tools: [],
            inferenceFatalRetries: 0,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Auth." }] }],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "authentication" },
        });
    });

    it("reports the total request count once every retry budget is spent", async () => {
        let attempts = 0;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            waitForInferenceRetry: async () => {},
            fetch: async () => {
                attempts += 1;
                return Response.json(
                    { error: { message: "The server had an error." } },
                    { status: 500 },
                );
            },
        });
        const session = await provider.session("responses-exhausted-attempts", {
            instructions: "",
            tools: [],
            inferenceMaxRetries: 1,
        });

        const events = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Fail." }] }],
            },
        })) {
            events.push(event);
        }

        expect(attempts).toBe(2);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: {
                type: "internal_server_error",
                diagnostics: expect.objectContaining({ attempts: 2 }),
            },
        });
    });

    it("classifies transience without looping on a cyclic error cause", () => {
        const looped = new Error("boom");
        looped.cause = looped;
        expect(isTransientResponsesError(looped)).toBe(false);

        const outer = new Error("outer");
        const inner = Object.assign(new Error("inner"), { status: 503, cause: outer });
        outer.cause = inner;
        expect(isTransientResponsesError(outer)).toBe(true);
    });
});

function sseResponse(events: readonly unknown[]): Response {
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

function completedResponse(output: readonly unknown[], outputTokens: number): unknown {
    return {
        type: "response.completed",
        response: {
            id: `response-${String(outputTokens)}`,
            output,
            usage: {
                input_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: outputTokens,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 1 + outputTokens,
            },
        },
    };
}
