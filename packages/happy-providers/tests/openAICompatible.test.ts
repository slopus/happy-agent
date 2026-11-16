import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
    OpenAICompatibleProvider,
    assistantMessageFromEvents,
    committedSessionEvents,
    type OpenAICompatibleProviderOptions,
    type SessionContext,
    type SessionEvent,
    type SessionStream,
    type SessionTool,
} from "@/index.js";
import {
    glmCompactionInstructions,
    glmCompactionPrefix,
} from "@/vendors/glm/prompts/glm_compaction_instructions.js";
import { testContext } from "./testContext.js";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const TEXT_ONLY = "example/text-only";

const context: SessionContext = {
    instructions: "Caller-owned instructions.",
    messages: [{ role: "user", content: [{ type: "text", text: "Read the file." }] }],
};
const tools: readonly SessionTool[] = [
    {
        name: "Read",
        description: "Read a file.",
        parameters: Type.Object({ file_path: Type.String() }),
    },
];

function provider(
    fetcher: typeof fetch,
    overrides: Partial<OpenAICompatibleProviderOptions> = {},
): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
        apiKey: "test-openrouter-key",
        endpoint: "https://openrouter.example/api/v1",
        vendor: "OpenRouter",
        models: [
            { id: DEEPSEEK, inputTypes: ["text", "image"], efforts: ["low", "high", "max"] },
            { id: TEXT_ONLY },
        ],
        fetch: fetcher,
        inferenceMaxRetries: 0,
        ...overrides,
    });
}

describe("OpenAI-compatible Chat Completions provider", () => {
    it("sends the configured model, key, headers, and request extras to /chat/completions", async () => {
        const transport = mockTransport(() => answer());
        const session = await provider(transport.fetch, {
            model: DEEPSEEK,
            headers: { "X-Title": "Happy Agent" },
            request: { reasoning: { enabled: true }, provider: { sort: "price" } },
        }).session("wire", { instructions: context.instructions });
        try {
            const events = await collect(session.run(testContext, { context, effort: "high" }));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            const request = transport.requests[0]!;
            expect(request.url).toBe("https://openrouter.example/api/v1/chat/completions");
            expect(request.headers.get("authorization")).toBe("Bearer test-openrouter-key");
            expect(request.headers.get("x-title")).toBe("Happy Agent");
            expect(request.body).toEqual({
                model: DEEPSEEK,
                messages: [
                    { role: "system", content: context.instructions },
                    { role: "user", content: "Read the file." },
                ],
                stream: true,
                stream_options: { include_usage: true },
                reasoning: { enabled: true },
                provider: { sort: "price" },
                reasoning_effort: "high",
            });
        } finally {
            session.destroy();
        }
    });

    it("lets a model's own request fields win over the provider's", async () => {
        const transport = mockTransport(() => answer());
        const session = await provider(transport.fetch, {
            models: [{ id: DEEPSEEK, request: { reasoning: { enabled: false }, top_p: 0.9 } }],
            request: { reasoning: { enabled: true } },
        }).session("extras", { instructions: "" });
        try {
            await collect(session.run(testContext, { context }));
            expect(transport.requests[0]!.body).toMatchObject({
                reasoning: { enabled: false },
                top_p: 0.9,
            });
            expect(transport.requests[0]!.body).not.toHaveProperty("reasoning_effort");
        } finally {
            session.destroy();
        }
    });

    it("refuses configured extras that would replace protocol fields", () => {
        const transport = mockTransport(() => answer());
        expect(() => provider(transport.fetch, { request: { stream: false } })).toThrow(
            'The request field "stream" cannot be configured.',
        );
        expect(() =>
            provider(transport.fetch, { models: [{ id: DEEPSEEK, request: { model: "other" } }] }),
        ).toThrow('The request field "model" cannot be configured.');
    });

    it("rejects a model the endpoint is not configured to serve", async () => {
        const transport = mockTransport(() => answer());
        expect(() => provider(transport.fetch, { model: "unknown/model" })).toThrow(
            "OpenRouter is not configured to serve unknown/model.",
        );
        const session = await provider(transport.fetch).session("unknown", { instructions: "" });
        try {
            const events = await collect(
                session.run(testContext, { context, model: "unknown/model" }),
            );
            expect(events.at(-1)).toMatchObject({
                state: "error",
                message: "OpenRouter is not configured to serve unknown/model.",
            });
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it("validates effort against the model's configured list and maps off to none", async () => {
        const transport = mockTransport(() => answer());
        const session = await provider(transport.fetch, {
            models: [{ id: DEEPSEEK, efforts: ["off", "high"] }],
        }).session("effort", { instructions: "" });
        try {
            await collect(session.run(testContext, { context, effort: "off" }));
            expect(transport.requests[0]!.body.reasoning_effort).toBe("none");
            const rejected = await collect(session.run(testContext, { context, effort: "max" }));
            expect(rejected.at(-1)).toMatchObject({
                state: "error",
                message: `${DEEPSEEK} supports off, high reasoning effort, not max.`,
            });
            expect(transport.requests).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });

    it("rejects Ultra when the model has no configured effort support", async () => {
        const transport = mockTransport(() => answer());
        const session = await provider(transport.fetch, {
            models: [{ id: DEEPSEEK }],
        }).session("unsupported-ultra", { instructions: "" });
        try {
            const rejected = await collect(session.run(testContext, { context, effort: "ultra" }));
            expect(rejected.at(-1)).toMatchObject({
                state: "error",
                message: `${DEEPSEEK} does not advertise Ultra reasoning effort.`,
            });
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it.each(["ultra", "max"] as const)(
        "forwards explicitly configured %s effort",
        async (effort) => {
            const transport = mockTransport(() => answer());
            const session = await provider(transport.fetch, {
                models: [{ id: DEEPSEEK, efforts: ["max", "ultra"] }],
            }).session("configured-effort", { instructions: "" });
            try {
                const events = await collect(session.run(testContext, { context, effort }));
                expect(events.at(-1)).toMatchObject({ state: "normal" });
                expect(transport.requests[0]!.body.reasoning_effort).toBe(effort);
            } finally {
                session.destroy();
            }
        },
    );

    it("reports each model's configured input types and rejects images for text-only models", async () => {
        const transport = mockTransport(() => answer());
        expect(provider(transport.fetch, { model: DEEPSEEK }).inputTypes).toEqual([
            "text",
            "image",
        ]);
        expect(provider(transport.fetch, { model: TEXT_ONLY }).inputTypes).toEqual(["text"]);
        const imageContext: SessionContext = {
            instructions: "",
            messages: [
                {
                    role: "user",
                    content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
                },
            ],
        };
        const session = await provider(transport.fetch).session("images", { instructions: "" });
        try {
            const accepted = await collect(
                session.run(testContext, { context: imageContext, model: DEEPSEEK }),
            );
            expect(accepted.at(-1)).toMatchObject({ state: "normal" });
            expect(transport.requests[0]!.body.messages[0].content).toEqual([
                { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            ]);
            const rejected = await collect(
                session.run(testContext, { context: imageContext, model: TEXT_ONLY }),
            );
            expect(rejected.at(-1)).toMatchObject({
                state: "error",
                message: `${TEXT_ONLY} supports text input only.`,
            });
            expect(transport.requests).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });

    it("streams OpenRouter's reasoning field and a tool call, then replays them as configured", async () => {
        const transport = mockTransport((attempt) => (attempt === 0 ? toolAnswer() : answer()));
        const session = await provider(transport.fetch, { reasoningField: "reasoning" }).session(
            "tools",
            { instructions: context.instructions, tools },
        );
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
            const assistant = assistantMessageFromEvents(committedSessionEvents(events))!;
            expect(assistant.content).toEqual([
                { type: "reasoning", text: "Find the file." },
                {
                    type: "tool_call",
                    callId: "call_1",
                    name: "Read",
                    arguments: '{"file_path":"a.ts"}',
                },
            ]);
            expect(events).toContainEqual({
                type: "token_usage",
                usage: { input: 40, output: 9, cacheRead: 32, cacheWrite: 0, totalTokens: 49 },
            });
            const followUp: SessionContext = {
                ...context,
                messages: [
                    ...context.messages,
                    assistant,
                    {
                        role: "tool",
                        callId: "call_1",
                        content: [{ type: "text", text: "export {};" }],
                    },
                ],
            };
            await collect(session.run(testContext, { context: followUp }));
            expect(transport.requests[1]!.body.messages.slice(2)).toEqual([
                {
                    role: "assistant",
                    reasoning: "Find the file.",
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "call_1", content: "export {};" },
            ]);
            expect(transport.requests[0]!.body.tools).toEqual([
                {
                    type: "function",
                    function: {
                        name: "Read",
                        description: "Read a file.",
                        parameters: JSON.parse(JSON.stringify(tools[0]!.parameters)),
                    },
                },
            ]);
        } finally {
            session.destroy();
        }
    });

    it("keeps caller regex patterns on tool and structured-output schemas", async () => {
        const transport = mockTransport(() => answer('{"title":"Done"}'));
        const title = Type.Object({ title: Type.String({ pattern: "^(?=.*\\S).+$" }) });
        const patterned: SessionTool = {
            name: "Write",
            parameters: Type.Object({ path: Type.String({ pattern: "^(?!/).+$" }) }),
        };
        const session = await provider(transport.fetch).session("patterns", {
            instructions: "",
            tools: [patterned],
        });
        try {
            await collect(
                session.run(testContext, {
                    context,
                    structuredOutput: { name: "title", schema: title },
                }),
            );
            const body = transport.requests[0]!.body;
            expect(body.tools[0].function.parameters).toEqual(
                JSON.parse(JSON.stringify(patterned.parameters)),
            );
            expect(body.response_format.json_schema.schema).toEqual(
                JSON.parse(JSON.stringify(title)),
            );
        } finally {
            session.destroy();
        }
    });

    it("leaves reasoning off the wire unless a replay field is configured", async () => {
        const transport = mockTransport(() => answer());
        const session = await provider(transport.fetch).session("no-replay", { instructions: "" });
        try {
            await collect(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            ...context.messages,
                            {
                                role: "assistant",
                                content: [
                                    { type: "reasoning", text: "Private." },
                                    { type: "text", text: "Done." },
                                ],
                            },
                            { role: "user", content: [{ type: "text", text: "Thanks." }] },
                        ],
                    },
                }),
            );
            expect(transport.requests[0]!.body.messages[1]).toEqual({
                role: "assistant",
                content: "Done.",
            });
        } finally {
            session.destroy();
        }
    });

    it.each([
        {
            status: 401,
            type: "authentication",
            message: "Authentication with OpenRouter failed.",
        },
        { status: 402, type: "out_of_tokens", message: "402 Upstream request rejected." },
        { status: 429, type: "rate_limit", message: "The OpenRouter rate limit was reached." },
    ])("names the vendor when an HTTP $status ends the run", async ({ status, type, message }) => {
        const transport = mockTransport(() => errorResponse(status));
        const session = await provider(transport.fetch).session("errors", { instructions: "" });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message,
                providerError: { type },
            });
        } finally {
            session.destroy();
        }
    });

    it("retries a rate limit within its own budget and announces the vendor", async () => {
        const transport = mockTransport((attempt) =>
            attempt === 0 ? errorResponse(429) : answer(),
        );
        const session = await provider(transport.fetch, {
            inferenceMaxRetries: 1,
            waitForInferenceRetry: async () => {},
        }).session("retry", { instructions: "" });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events).toContainEqual({
                type: "retrying",
                attempt: 1,
                reason: "Retrying the OpenRouter inference request.",
            });
            expect(events.at(-1)).toMatchObject({ state: "normal" });
            expect(transport.requests).toHaveLength(2);
        } finally {
            session.destroy();
        }
    });

    it("compacts with Claude Code's non-Claude summary contract and no tools", async () => {
        const transport = mockTransport(() =>
            answer("<analysis>Notes.</analysis>\n<summary>The file was read.</summary>"),
        );
        const session = await provider(transport.fetch).session("compact", {
            instructions: context.instructions,
            tools,
        });
        try {
            const result = await session.compact(testContext, { context });
            expect(result.status).toBe("completed");
            const body = transport.requests[0]!.body;
            expect(body).not.toHaveProperty("tools");
            expect(body.messages.at(-1)).toEqual({
                role: "user",
                content: glmCompactionInstructions,
            });
            if (result.status !== "completed") return;
            expect(result.context.messages).toHaveLength(1);
            expect(result.context.messages[0]).toMatchObject({ role: "compaction" });
            const content = (result.context.messages[0] as { content: string }).content;
            expect(content.startsWith(`${glmCompactionPrefix}Summary:\nThe file was read.`)).toBe(
                true,
            );
            expect(context.messages).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });
});

async function collect(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function mockTransport(respond: (attempt: number) => Response) {
    const requests: { url: string; headers: Headers; body: Record<string, any> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        requests.push({
            url: input instanceof Request ? input.url : String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
        });
        return respond(requests.length - 1);
    };
    return { fetch: fetcher, requests };
}

function chunk(delta: object, finish_reason: string | null = null) {
    return { choices: [{ index: 0, delta, finish_reason }] };
}

function sse(chunks: readonly object[]): Response {
    return new Response(
        chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
    );
}

function usage() {
    return {
        choices: [],
        usage: {
            prompt_tokens: 40,
            completion_tokens: 9,
            prompt_tokens_details: { cached_tokens: 32 },
        },
    };
}

function answer(text = "Complete."): Response {
    return sse([chunk({ content: text }), chunk({}, "stop"), usage()]);
}

/** The shape OpenRouter streams: reasoning under `reasoning`, then one function call. */
function toolAnswer(): Response {
    return sse([
        chunk({ role: "assistant", content: "", reasoning: "Find " }),
        chunk({ content: "", reasoning: "the file." }),
        chunk({
            content: null,
            tool_calls: [
                {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "Read", arguments: '{"file_path":' },
                },
            ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
        chunk({}, "tool_calls"),
        usage(),
    ]);
}

function errorResponse(status: number): Response {
    return new Response(
        JSON.stringify({ error: { message: "Upstream request rejected.", code: status } }),
        {
            status,
            headers: { "content-type": "application/json" },
        },
    );
}
