import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
    BedrockAwsCredential,
    BedrockBearerTokenCredential,
    GlmProvider,
    KimiProvider,
    assistantMessageFromEvents,
    committedSessionEvents,
    type BaseSession,
    type SessionContext,
    type SessionEvent,
    type SessionStream,
    type SessionTool,
} from "@/index.js";
import {
    kimiCompactionInstructions,
    kimiCompactionPrefix,
} from "@/vendors/kimi/prompts/kimi_compaction_instructions.js";
import { kimi_k3_system_prompt } from "@/vendors/kimi/prompts/kimi_k3_system_prompt.js";
import {
    glmCompactionInstructions,
    glmCompactionPrefix,
} from "@/vendors/glm/prompts/glm_compaction_instructions.js";
import { glm_5_3_system_prompt } from "@/vendors/glm/prompts/glm_5_3_system_prompt.js";
import { testContext, testContextWith } from "./testContext.js";

const providers = [
    {
        name: "Kimi K3",
        Provider: KimiProvider,
        model: "moonshotai/kimi-k3",
        runtimeModel: "moonshotai.kimi-k3",
        prompt: kimi_k3_system_prompt,
        compactionInstructions: kimiCompactionInstructions,
        compactionPrefix: kimiCompactionPrefix,
        generation: { reasoning_effort: "max" },
    },
    {
        name: "GLM 5.3",
        Provider: GlmProvider,
        model: "zai/glm-5.3",
        runtimeModel: "zai.glm-5.3",
        prompt: glm_5_3_system_prompt,
        compactionInstructions: glmCompactionInstructions,
        compactionPrefix: glmCompactionPrefix,
        generation: { reasoning_effort: "max" },
    },
] as const;

const context: SessionContext = {
    instructions: "Caller-owned instructions.",
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect both files." }] }],
};
const kimiContinuation =
    "<system-reminder>\nContext compaction is complete — continue the work that was in progress when it began.\n</system-reminder>";
const glmContinuation =
    'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
const tools: readonly SessionTool[] = [
    {
        name: "read",
        namespace: "files",
        description: "Read a file.",
        parameters: Type.Object({ path: Type.String() }),
    },
    { name: "search", parameters: Type.Object({ query: Type.String() }) },
];

describe.each(providers)("$name on Bedrock Runtime", (vendor) => {
    it.each([
        { region: "us-east-1", prefix: "us" },
        { region: "eu-west-1", prefix: "global" },
    ])(
        "uses the Runtime endpoint and $prefix inference profile in $region",
        async ({ region, prefix }) => {
            const transport = mockTransport(() => answer());
            const provider = new vendor.Provider({
                credential: await bearer(),
                region,
                fetch: transport.fetch,
            });
            const session = await provider.session("routing", {
                instructions: context.instructions,
            });
            try {
                const events = await collect(session.run(testContext, { context }));
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(transport.requests).toHaveLength(1);
                expect(transport.requests[0]).toMatchObject({
                    url: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1/chat/completions`,
                    method: "POST",
                    body: {
                        model: `${prefix}.${vendor.runtimeModel}`,
                        messages: [
                            { role: "system", content: context.instructions },
                            { role: "user", content: "Inspect both files." },
                        ],
                        stream: true,
                        stream_options: { include_usage: true },
                        ...vendor.generation,
                    },
                });
                expect(transport.requests[0]!.headers.get("authorization")).toBe(
                    "Bearer test-bedrock-token",
                );
            } finally {
                session.destroy();
            }
        },
    );

    it("honors an explicit Runtime base URL, model profile, and user agent", async () => {
        const transport = mockTransport(() => answer());
        const provider = new vendor.Provider({
            credential: await bearer(),
            endpoint: "https://runtime.example/openai/v1",
            model: `global.${vendor.runtimeModel}`,
            userAgent: "provider-test/1",
            fetch: transport.fetch,
        });
        const session = await provider.session("explicit-routing", {
            instructions: context.instructions,
        });
        try {
            await collect(session.run(testContext, { context }));
            expect(transport.requests[0]!.url).toBe(
                "https://runtime.example/openai/v1/chat/completions",
            );
            expect(transport.requests[0]!.body.model).toBe(`global.${vendor.runtimeModel}`);
            expect(transport.requests[0]!.headers.get("user-agent")).toBe("provider-test/1");
        } finally {
            session.destroy();
        }
    });

    it("SigV4-signs every request for the bedrock service using refreshable AWS credentials", async () => {
        let resolutions = 0;
        const credential = await BedrockAwsCredential.tryLoad({
            credentialProvider: async () => ({
                accessKeyId: `TESTACCESS${++resolutions}`,
                secretAccessKey: "test-secret-key",
                sessionToken: `test-session-${resolutions}`,
            }),
        });
        if (credential === null) throw new Error("Missing AWS test credential.");
        const transport = mockTransport(() => answer());
        const provider = new vendor.Provider({
            credential,
            region: "eu-west-1",
            fetch: transport.fetch,
        });
        const session = await provider.session("signed", { instructions: context.instructions });
        try {
            await collect(session.run(testContext, { context }));
            await collect(session.run(testContext, { context }));
            expect(transport.requests).toHaveLength(2);
            for (const [index, request] of transport.requests.entries()) {
                expect(request.headers.get("authorization")).toMatch(
                    new RegExp(
                        `^AWS4-HMAC-SHA256 Credential=TESTACCESS${index + 2}/\\d{8}/eu-west-1/bedrock/aws4_request,`,
                    ),
                );
                expect(request.headers.get("x-amz-security-token")).toBe(
                    `test-session-${index + 2}`,
                );
                expect(request.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/u);
                expect(request.headers.get("host")).toBe("bedrock-runtime.eu-west-1.amazonaws.com");
                expect(request.redirect).toBe("manual");
            }
        } finally {
            session.destroy();
        }
    });

    it("rejects unknown constructor and per-run model IDs before sending a request", async () => {
        const transport = mockTransport(() => answer());
        const credential = await bearer();
        await expect(
            new vendor.Provider({
                credential,
                model: "unknown-model",
                fetch: transport.fetch,
            }).session("bad-model", { instructions: "" }),
        ).rejects.toThrow(/Bedrock model selection/u);
        const session = await new vendor.Provider({ credential, fetch: transport.fetch }).session(
            "bad-run-model",
            { instructions: "" },
        );
        try {
            const events = await collect(
                session.run(testContext, { context, model: "unknown-model" }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it("replays parallel fragmented tool calls with reasoning and caller-selected identities", async () => {
        const transport = mockTransport((attempt) =>
            attempt === 0 ? toolAnswer() : answer("Both files checked."),
        );
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("tools", { instructions: context.instructions, tools });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events.filter((event) => event.type === "toolcall_start")).toEqual([
                { type: "toolcall_start", callId: "call-read", name: "read", namespace: "files" },
                { type: "toolcall_start", callId: "call-search", name: "search" },
            ]);
            expect(events.filter((event) => event.type === "toolcall_end")).toEqual([
                { type: "toolcall_end", callId: "call-read", arguments: '{"path":"one.ts"}' },
                { type: "toolcall_end", callId: "call-search", arguments: '{"query":"two"}' },
            ]);
            expect(events.at(-1)).toEqual({
                type: "done",
                state: "tool_call",
                tokens: { input: 120, output: 18 },
            });
            expect(events).toContainEqual({
                type: "token_usage",
                usage: { input: 120, output: 18, cacheRead: 80, cacheWrite: 0, totalTokens: 138 },
            });
            const assistant = assistantMessageFromEvents(events);
            if (assistant === undefined) throw new Error("Missing assistant tool turn.");
            expect(assistant.content.map((block) => block.type)).toEqual([
                "reasoning",
                "text",
                "tool_call",
                "tool_call",
            ]);
            const continuation: SessionContext = {
                instructions: context.instructions,
                messages: [
                    ...context.messages,
                    {
                        ...assistant,
                        content: assistant.content.map((block) =>
                            block.type === "tool_call"
                                ? { ...block, callId: `stored-${block.callId}` }
                                : block,
                        ),
                    },
                    {
                        role: "tool",
                        callId: "stored-call-read",
                        content: [{ type: "text", text: "one.ts contents" }],
                    },
                    {
                        role: "tool",
                        callId: "stored-call-search",
                        content: [{ type: "text", text: "two matches" }],
                    },
                ],
            };
            const before = JSON.stringify(continuation);
            const final = await collect(session.run(testContext, { context: continuation }));
            expect(final.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(JSON.stringify(continuation)).toBe(before);
            expect(transport.requests[1]!.body.messages).toEqual([
                { role: "system", content: context.instructions },
                { role: "user", content: "Inspect both files." },
                {
                    role: "assistant",
                    content: "Checking.",
                    reasoning_content: "Compare both files.",
                    tool_calls: [
                        {
                            id: "stored-call-read",
                            type: "function",
                            function: { name: "files__read", arguments: '{"path":"one.ts"}' },
                        },
                        {
                            id: "stored-call-search",
                            type: "function",
                            function: { name: "search", arguments: '{"query":"two"}' },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "stored-call-read", content: "one.ts contents" },
                { role: "tool", tool_call_id: "stored-call-search", content: "two matches" },
            ]);
            expect(transport.requests[1]!.body.tools).toEqual(
                JSON.parse(
                    JSON.stringify([
                        {
                            type: "function",
                            function: {
                                name: "files__read",
                                description: "Read a file.",
                                parameters: tools[0]!.parameters,
                            },
                        },
                        {
                            type: "function",
                            function: { name: "search", parameters: tools[1]!.parameters },
                        },
                    ]),
                ),
            );
            expect(transport.requests[1]!.body.tools).toEqual(transport.requests[0]!.body.tools);
        } finally {
            session.destroy();
        }
    });

    it("marks a tool interrupted by the output limit as incomplete", async () => {
        const transport = mockTransport(() =>
            sse([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "unfinished",
                            function: { name: "files__read", arguments: '{"path":' },
                        },
                    ],
                }),
                chunk({}, "length"),
            ]),
        );
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("length", { instructions: "", tools });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events).toContainEqual({
                type: "toolcall_end",
                callId: "unfinished",
                arguments: '{"path":',
                incomplete: true,
            });
            expect(assistantMessageFromEvents(events)?.content).toEqual([
                {
                    type: "tool_call",
                    callId: "unfinished",
                    name: "read",
                    namespace: "files",
                    arguments: '{"path":',
                    incomplete: true,
                },
            ]);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "length" });
        } finally {
            session.destroy();
        }
    });

    it("assembles a tool call when its identity arrives before fragmented function names", async () => {
        const transport = mockTransport(() =>
            sse([
                chunk({ tool_calls: [{ index: 0, id: "split-read" }] }),
                chunk({
                    tool_calls: [
                        { index: 0, function: { name: "files__", arguments: '{"path":' } },
                    ],
                }),
                chunk({
                    tool_calls: [{ index: 0, function: { name: "read", arguments: '"one.ts"}' } }],
                }),
                chunk({}, "tool_calls"),
                usageChunk(),
            ]),
        );
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 0,
        }).session("fragmented-name", { instructions: context.instructions, tools });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events.at(-1)).toEqual({
                type: "done",
                state: "tool_call",
                tokens: { input: 120, output: 18 },
            });
            expect(events.filter((event) => event.type === "toolcall_start")).toEqual([
                { type: "toolcall_start", callId: "split-read", name: "read", namespace: "files" },
            ]);
            expect(events.filter((event) => event.type === "toolcall_end")).toEqual([
                { type: "toolcall_end", callId: "split-read", arguments: '{"path":"one.ts"}' },
            ]);
            expect(assistantMessageFromEvents(events)?.content).toEqual([
                {
                    type: "tool_call",
                    callId: "split-read",
                    name: "read",
                    namespace: "files",
                    arguments: '{"path":"one.ts"}',
                },
            ]);
            expect(transport.requests).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });

    it.each([true, false])(
        "buffers early argument fragments until the named tool header arrives (early identity: %s)",
        async (earlyIdentity) => {
            const transport = mockTransport(() =>
                sse([
                    chunk({
                        tool_calls: [
                            {
                                index: 0,
                                ...(earlyIdentity ? { id: "early-arguments" } : {}),
                                function: { arguments: '{"path":' },
                            },
                        ],
                    }),
                    chunk({
                        tool_calls: [
                            {
                                index: 0,
                                ...(!earlyIdentity ? { id: "early-arguments" } : {}),
                                function: { name: "files__read", arguments: '"one.ts"}' },
                            },
                        ],
                    }),
                    chunk({}, "tool_calls"),
                    usageChunk(),
                ]),
            );
            const session = await new vendor.Provider({
                credential: await bearer(),
                fetch: transport.fetch,
                inferenceMaxRetries: 0,
            }).session("early-arguments", { instructions: context.instructions, tools });
            try {
                const events = await collect(session.run(testContext, { context }));
                expect(events.at(-1)).toEqual({
                    type: "done",
                    state: "tool_call",
                    tokens: { input: 120, output: 18 },
                });
                expect(events.filter((event) => event.type === "toolcall_start")).toEqual([
                    {
                        type: "toolcall_start",
                        callId: "early-arguments",
                        name: "read",
                        namespace: "files",
                    },
                ]);
                expect(assistantMessageFromEvents(events)?.content).toEqual([
                    {
                        type: "tool_call",
                        callId: "early-arguments",
                        name: "read",
                        namespace: "files",
                        arguments: '{"path":"one.ts"}',
                    },
                ]);
            } finally {
                session.destroy();
            }
        },
    );

    it.each(["rate limit", "network failure", "empty response", "truncated tool stream"])(
        "retries a %s and commits only the successful attempt",
        async (failure) => {
            const transport = mockTransport((attempt) => {
                if (attempt > 0) return answer("Committed answer.");
                if (failure === "rate limit") return errorResponse(429, "rate_limit_error");
                if (failure === "network failure") throw new TypeError("fetch failed");
                if (failure === "empty response") return sse([chunk({}, "stop")]);
                return sse([
                    chunk({ content: "Discard this." }),
                    chunk({
                        tool_calls: [
                            {
                                index: 0,
                                id: "discarded-call",
                                function: { name: "files__read", arguments: '{"path":' },
                            },
                        ],
                    }),
                ]);
            });
            const waits: number[] = [];
            const session = await new vendor.Provider({
                credential: await bearer(),
                fetch: transport.fetch,
                inferenceMaxRetries: 1,
                waitForInferenceRetry: async (attempt) => {
                    waits.push(attempt);
                },
            }).session("retry", { instructions: context.instructions, tools });
            try {
                const events = await collect(session.run(testContext, { context }));
                expect(transport.requests).toHaveLength(2);
                expect(transport.requests[1]!.body).toEqual(transport.requests[0]!.body);
                expect(waits).toEqual([1]);
                expect(events.filter((event) => event.type === "block_reset")).toHaveLength(1);
                expect(events.filter((event) => event.type === "retrying")).toEqual([
                    {
                        type: "retrying",
                        attempt: 1,
                        reason: "Retrying the Bedrock inference request.",
                    },
                ]);
                expect(
                    committedSessionEvents(events).filter(
                        (event) => event.type === "toolcall_start",
                    ),
                ).toEqual([]);
                expect(assistantMessageFromEvents(events)?.content).toEqual([
                    { type: "text", text: "Committed answer." },
                ]);
                expect(events.filter((event) => event.type === "done")).toHaveLength(1);
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            } finally {
                session.destroy();
            }
        },
    );

    it.each([401, 403])("treats HTTP %s authentication failures as terminal", async (status) => {
        const transport = mockTransport(() => errorResponse(status, "authentication_error"));
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 5,
        }).session("auth-error", { instructions: "" });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(transport.requests).toHaveLength(1);
            expect(events.filter((event) => event.type === "retrying")).toEqual([]);
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message: "Authentication with Amazon Bedrock failed.",
                providerError: { type: "authentication", diagnostics: { status, attempts: 1 } },
            });
        } finally {
            session.destroy();
        }
    });

    it("honors a session retry budget of zero and reports the exhausted rate limit", async () => {
        const transport = mockTransport(() => errorResponse(429, "rate_limit_error"));
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 4,
        }).session("no-retries", { instructions: "", inferenceMaxRetries: 0 });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(transport.requests).toHaveLength(1);
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                providerError: { type: "rate_limit", diagnostics: { attempts: 1, status: 429 } },
            });
        } finally {
            session.destroy();
        }
    });

    it("stops after exhausting its retry budget and reports the final attempt count", async () => {
        const transport = mockTransport(() => errorResponse(429, "rate_limit_error"));
        const waits: number[] = [];
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 2,
            waitForInferenceRetry: async (attempt) => {
                waits.push(attempt);
            },
        }).session("exhausted", { instructions: "" });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(transport.requests).toHaveLength(3);
            expect(waits).toEqual([1, 2]);
            expect(events.filter((event) => event.type === "done")).toHaveLength(1);
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                providerError: { type: "rate_limit", diagnostics: { attempts: 3 } },
            });
            expect(assistantMessageFromEvents(events)).toBeUndefined();
        } finally {
            session.destroy();
        }
    });

    it.each(["off", "minimal", "medium", "xhigh"] as const)(
        "rejects unsupported effort %s without a network request",
        async (effort) => {
            const transport = mockTransport(() => answer());
            const session = await new vendor.Provider({
                credential: await bearer(),
                fetch: transport.fetch,
            }).session("unsupported-effort", { instructions: "" });
            try {
                expect(
                    (await collect(session.run(testContext, { context, effort }))).at(-1),
                ).toMatchObject({ type: "done", state: "error" });
                expect(transport.requests).toHaveLength(0);
            } finally {
                session.destroy();
            }
        },
    );

    it("rejects inference speed tiers before transport", async () => {
        const transport = mockTransport(() => answer());
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("speed-tier", { instructions: "" });
        try {
            expect(
                (await collect(session.run(testContext, { context, serviceTier: "priority" }))).at(
                    -1,
                ),
            ).toMatchObject({
                type: "done",
                state: "error",
                message: "These Bedrock models do not support inference speed tiers.",
            });
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it("preserves structured output schemas on the wire", async () => {
        const transport = mockTransport(() => answer('{"result":"done"}'));
        const schema = Type.Object({ result: Type.String() }, { additionalProperties: false });
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("structured", { instructions: "" });
        try {
            await collect(
                session.run(testContext, { context, structuredOutput: { name: "result", schema } }),
            );
            expect(transport.requests[0]!.body.response_format).toEqual({
                type: "json_schema",
                json_schema: { name: "result", schema: JSON.parse(JSON.stringify(schema)) },
            });
        } finally {
            session.destroy();
        }
    });

    it("rejects ambiguous serialized tool names before transport", async () => {
        const transport = mockTransport(() => answer());
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("duplicate-tools", {
            instructions: "",
            tools: [{ name: "read", namespace: "files" }, { name: "files__read" }],
        });
        try {
            expect((await collect(session.run(testContext, { context }))).at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message:
                    "Chat Completions tool names must be unique after namespace serialization.",
            });
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it("rewinds a tool call whose correlation identity changes during streaming", async () => {
        const transport = mockTransport(() =>
            sse([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "original",
                            function: { name: "files__read", arguments: "{" },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [{ index: 0, id: "replacement", function: { arguments: "}" } }],
                }),
                chunk({}, "tool_calls"),
            ]),
        );
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 0,
        }).session("unstable-call-id", { instructions: "", tools });
        try {
            const events = await collect(session.run(testContext, { context }));
            expect(events).toContainEqual({
                type: "toolcall_start",
                callId: "original",
                name: "read",
                namespace: "files",
            });
            expect(events).toContainEqual({ type: "block_reset" });
            expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
            expect(assistantMessageFromEvents(events)).toBeUndefined();
        } finally {
            session.destroy();
        }
    });

    it("cancels before inference without issuing a request", async () => {
        const transport = mockTransport(() => answer());
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("cancel-before", { instructions: "" });
        const controller = new AbortController();
        controller.abort();
        try {
            expect(
                await collect(session.run(testContextWith(controller.signal), { context })),
            ).toEqual([{ type: "done", state: "cancelled" }]);
            expect(transport.requests).toHaveLength(0);
        } finally {
            session.destroy();
        }
    });

    it("rewinds streamed output on cancellation and remains usable for a later run", async () => {
        const transport = mockTransport(() => answer());
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("cancel-stream", { instructions: "" });
        const controller = new AbortController();
        const events: SessionEvent[] = [];
        try {
            for await (const event of session.run(testContextWith(controller.signal), {
                context,
            })) {
                events.push(event);
                if (event.type === "text_delta") controller.abort();
            }
            expect(events).toContainEqual({ type: "block_reset" });
            expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
            expect(assistantMessageFromEvents(events)).toBeUndefined();
            expect(events.filter((event) => event.type === "retrying")).toEqual([]);
            expect((await collect(session.run(testContext, { context }))).at(-1)).toMatchObject({
                state: "normal",
            });
        } finally {
            session.destroy();
        }
    });

    it("selects alternate instructions and tools without mutating caller context", async () => {
        const transport = mockTransport(() => answer());
        const model = `global.${vendor.runtimeModel}`;
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("configuration", {
            instructions: "Default instructions.",
            tools,
            modelConfigurations: {
                [model]: { instructions: vendor.prompt, tools: [{ name: "alternate" }] },
            },
        });
        const before = JSON.stringify(context);
        try {
            await collect(session.run(testContext, { context, model }));
            expect(transport.requests[0]!.body.messages[0]).toEqual({
                role: "system",
                content: vendor.prompt,
            });
            expect(
                transport.requests[0]!.body.tools.map(
                    (tool: { function: { name: string } }) => tool.function.name,
                ),
            ).toEqual(["alternate"]);
            await collect(session.run(testContext, { context }));
            expect(transport.requests[1]!.body.model).toBe(model);
            expect(transport.requests[1]!.body.messages[0]).toEqual({
                role: "system",
                content: vendor.prompt,
            });
            expect(JSON.stringify(context)).toBe(before);
        } finally {
            session.destroy();
        }
    });

    it("compacts with the native harness prompt and resumes from the returned summary", async () => {
        const transport = mockTransport((attempt) =>
            answer(attempt === 0 ? "Keep the next action." : "Resumed."),
        );
        const provider = new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        });
        const session = await provider.session("compact", {
            instructions: context.instructions,
            tools,
        });
        let resumed: BaseSession | undefined;
        const before = JSON.stringify(context);
        try {
            const result = await session.compact(testContext, {
                context,
                instructions: "Retain exact file names.",
            });
            expect(result.status).toBe("completed");
            if (result.status !== "completed") throw new Error("Expected completed compaction.");
            expect(result.summary).toBe("Keep the next action.");
            expect(result.usage).toEqual({
                input: 120,
                output: 18,
                cacheRead: 80,
                cacheWrite: 0,
                totalTokens: 138,
            });
            expect(transport.requests[0]!.body.messages).toEqual([
                { role: "system", content: context.instructions },
                { role: "user", content: "Inspect both files." },
                {
                    role: "user",
                    content: vendor.compactionInstructions.includes("${custom_instruction_block}")
                        ? vendor.compactionInstructions
                              .replace(
                                  "${custom_instruction_block}",
                                  "\nOptional user instruction:\nRetain exact file names.\n",
                              )
                              .trimEnd()
                        : `${vendor.compactionInstructions}\nOptional user instruction:\nRetain exact file names.\n`,
                },
            ]);
            expect(transport.requests[0]!.body).not.toHaveProperty("tools");
            expect(JSON.stringify(context)).toBe(before);
            const isKimi = vendor.Provider === KimiProvider;
            const summary = isKimi
                ? `${vendor.compactionPrefix.trimEnd()}\nKeep the next action.`
                : `${vendor.compactionPrefix}Keep the next action.\n${glmContinuation}`;
            expect(result.context.instructions).toBe(context.instructions);
            expect(result.preservedMessages).toEqual(isKimi ? context.messages : []);
            if (isKimi) {
                expect(result.context.messages).toEqual([
                    ...context.messages,
                    {
                        role: "compaction",
                        content: summary,
                        encryptedContent: null,
                        vendor: { type: "kimi_summary", continuation: kimiContinuation },
                    },
                ]);
            } else {
                expect(result.context.messages).toEqual([
                    {
                        role: "compaction",
                        content: summary,
                        encryptedContent: null,
                        vendor: { type: "glm_summary" },
                    },
                ]);
            }
            // A new session must resume from persisted context without hidden transport state.
            resumed = await provider.session("compact-restored", {
                instructions: context.instructions,
                tools,
            });
            const events = await collect(resumed.run(testContext, { context: result.context }));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(transport.requests[1]!.body.messages).toEqual([
                { role: "system", content: context.instructions },
                ...(isKimi ? [{ role: "user", content: "Inspect both files." }] : []),
                { role: "user", content: summary },
                ...(isKimi ? [{ role: "user", content: kimiContinuation }] : []),
            ]);
            expect(transport.requests[1]!.body.tools).toHaveLength(2);
            // Producing a replacement does not silently install it on the original session.
            await collect(session.run(testContext, { context }));
            expect(transport.requests[2]!.body.messages[1]).toEqual({
                role: "user",
                content: "Inspect both files.",
            });
            const recompacted = await session.compact(testContext, { context: result.context });
            expect(recompacted.status).toBe("completed");
            if (recompacted.status !== "completed")
                throw new Error("Expected repeated compaction to complete.");
            expect(recompacted.preservedMessages).toEqual(isKimi ? context.messages : []);
            expect(
                recompacted.context.messages.filter((message) => message.role === "compaction"),
            ).toHaveLength(1);
            const checkpoint = recompacted.context.messages.at(-1);
            expect(checkpoint).toMatchObject({
                role: "compaction",
                content: isKimi
                    ? `${vendor.compactionPrefix.trimEnd()}\nResumed.`
                    : `${vendor.compactionPrefix}Resumed.\n${glmContinuation}`,
            });
            expect(JSON.stringify(recompacted.context)).not.toContain("Keep the next action.");
        } finally {
            session.destroy();
            resumed?.destroy();
        }
    });

    it("keeps caller context when compaction is cancelled or fails", async () => {
        const transport = mockTransport(() => errorResponse(401, "authentication_error"));
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("compact-failed", { instructions: context.instructions });
        const controller = new AbortController();
        controller.abort();
        const before = JSON.stringify(context);
        try {
            expect(await session.compact(testContextWith(controller.signal), { context })).toEqual({
                status: "cancelled",
                context,
            });
            expect(transport.requests).toHaveLength(0);
            expect(await session.compact(testContext, { context })).toMatchObject({
                status: "failed",
                kind: "inference_error",
            });
            expect(JSON.stringify(context)).toBe(before);
        } finally {
            session.destroy();
        }
    });

    it("cancels active compaction when its owning session is destroyed", async () => {
        let session: BaseSession;
        let pulls = 0;
        const transport = mockTransport(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>(
                        {
                            pull(controller) {
                                pulls++;
                                if (pulls === 1) {
                                    controller.enqueue(
                                        new TextEncoder().encode(
                                            `data: ${JSON.stringify(chunk({ content: "Partial summary." }))}\n\n`,
                                        ),
                                    );
                                } else {
                                    session.destroy();
                                    controller.close();
                                }
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                    { headers: { "content-type": "text/event-stream" } },
                ),
        );
        session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
            inferenceMaxRetries: 0,
        }).session("destroy-compacting", { instructions: context.instructions });
        const before = JSON.stringify(context);
        try {
            const result = await session.compact(testContext, { context });
            expect(pulls).toBe(2);
            expect(transport.requests).toHaveLength(1);
            expect(result).toEqual({ status: "cancelled", context });
            if (result.status !== "cancelled")
                throw new Error("Expected destruction to cancel active compaction.");
            expect(result.context).toBe(context);
            expect(JSON.stringify(context)).toBe(before);
            expect((await collect(session.run(testContext, { context }))).at(-1)).toMatchObject({
                type: "done",
                state: "error",
            });
            expect(transport.requests).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });

    it("rejects a tool response to compaction without replacing caller context", async () => {
        const transport = mockTransport(() => toolAnswer());
        const session = await new vendor.Provider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("compact-tool", { instructions: context.instructions, tools });
        const before = JSON.stringify(context);
        try {
            expect(await session.compact(testContext, { context })).toMatchObject({
                status: "failed",
                kind: "tool_call",
            });
            expect(JSON.stringify(context)).toBe(before);
            expect(transport.requests[0]!.body).not.toHaveProperty("tools");
        } finally {
            session.destroy();
        }
    });
});

describe("provider-specific reasoning and input contracts", () => {
    it("formats GLM's native tagged summary and appends the Claude Code continuation", async () => {
        const transport = mockTransport(() =>
            answer(
                "<analysis>Private summary preparation.</analysis>\n\n<summary>Keep exact identifiers.</summary>",
            ),
        );
        const session = await new GlmProvider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("glm-summary-format", { instructions: context.instructions });
        try {
            const result = await session.compact(testContext, { context });
            if (result.status !== "completed")
                throw new Error("Expected GLM tagged summary to complete.");
            expect(result.context.messages).toEqual([
                {
                    role: "compaction",
                    content: `${glmCompactionPrefix}Summary:\nKeep exact identifiers.\n${glmContinuation}`,
                    encryptedContent: null,
                    vendor: { type: "glm_summary" },
                },
            ]);
            expect(result.preservedMessages).toEqual([]);
            await collect(session.run(testContext, { context: result.context }));
            expect(transport.requests[1]!.body.messages).toEqual([
                { role: "system", content: context.instructions },
                {
                    role: "user",
                    content: `${glmCompactionPrefix}Summary:\nKeep exact identifiers.\n${glmContinuation}`,
                },
            ]);
            expect(JSON.stringify(transport.requests[1]!.body)).not.toContain(
                "Private summary preparation.",
            );
        } finally {
            session.destroy();
        }
    });

    it("bounds Kimi preserved user input while retaining its head and latest suffix", async () => {
        const originalText = `ORIGINAL-ASK:${"a".repeat(20_000)}OMITTED-MIDDLE:${"b".repeat(80_000)}LATEST-ASK`;
        const largeContext: SessionContext = {
            instructions: "Keep the current work.",
            messages: [{ role: "user", content: [{ type: "text", text: originalText }] }],
        };
        const before = JSON.stringify(largeContext);
        const transport = mockTransport(() => answer("Finish the latest ask."));
        const session = await new KimiProvider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("large-compaction", { instructions: largeContext.instructions });
        try {
            const result = await session.compact(testContext, { context: largeContext });
            if (result.status !== "completed")
                throw new Error("Expected large Kimi compaction to complete.");
            const preservedUsers = result.preservedMessages.filter(
                (message) => message.role === "user",
            );
            expect(preservedUsers).toHaveLength(2);
            const text = preservedUsers.map((message) =>
                message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join(""),
            );
            expect(text[0]).toMatch(/^ORIGINAL-ASK:/u);
            expect(text[1]).toMatch(/LATEST-ASK$/u);
            expect(text[0]!.length).toBeLessThanOrEqual(8_000);
            expect(text[1]!.length).toBeLessThanOrEqual(72_000);
            expect(text.join("").includes("OMITTED-MIDDLE:")).toBe(false);
            expect(JSON.stringify(largeContext)).toBe(before);
            await collect(session.run(testContext, { context: result.context }));
            const wireMessages = transport.requests[1]!.body.messages as {
                role: string;
                content: string;
            }[];
            expect(wireMessages.map((message) => message.content)).toEqual([
                largeContext.instructions,
                text[0],
                expect.stringContaining(
                    "Some of this conversation's user messages were omitted here during compaction:",
                ),
                text[1],
                `${kimiCompactionPrefix.trimEnd()}\nFinish the latest ask.`,
                kimiContinuation,
            ]);
            const repeated = await session.compact(testContext, { context: result.context });
            if (repeated.status !== "completed")
                throw new Error("Expected repeated large Kimi compaction to complete.");
            await collect(session.run(testContext, { context: repeated.context }));
            const replay = transport.requests[3]!.body.messages as { content: string }[];
            expect(replay.filter((message) => message.content === kimiContinuation)).toHaveLength(
                1,
            );
            expect(
                replay.filter((message) =>
                    message.content.startsWith(kimiCompactionPrefix.trimEnd()),
                ),
            ).toHaveLength(1);
            expect(
                replay.filter((message) =>
                    message.content.includes(
                        "Some of this conversation's user messages were omitted",
                    ),
                ),
            ).toHaveLength(1);
        } finally {
            session.destroy();
        }
    });

    it.each(["low", "high", "max"] as const)(
        "uses K3 top-level reasoning_effort %s",
        async (effort) => {
            const transport = mockTransport(() => answer());
            const session = await new KimiProvider({
                credential: await bearer(),
                fetch: transport.fetch,
            }).session("kimi-effort", { instructions: "" });
            try {
                await collect(session.run(testContext, { context, effort }));
                expect(transport.requests[0]!.body.reasoning_effort).toBe(effort);
                expect(transport.requests[0]!.body).not.toHaveProperty("thinking");
            } finally {
                session.destroy();
            }
        },
    );

    it.each(["low", "high", "max"] as const)("uses GLM reasoning_effort %s", async (effort) => {
        const transport = mockTransport(() => answer());
        const session = await new GlmProvider({
            credential: await bearer(),
            fetch: transport.fetch,
        }).session("glm-effort", { instructions: "" });
        try {
            await collect(session.run(testContext, { context, effort }));
            expect(transport.requests[0]!.body.reasoning_effort).toBe(effort);
            expect(transport.requests[0]!.body).not.toHaveProperty("thinking");
        } finally {
            session.destroy();
        }
    });

    it("accepts image input for Kimi and rejects it for GLM before transport", async () => {
        const imageContext: SessionContext = {
            instructions: "Inspect the image.",
            messages: [
                {
                    role: "user",
                    content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
                },
            ],
        };
        for (const vendor of providers) {
            const transport = mockTransport(() => answer());
            const session = await new vendor.Provider({
                credential: await bearer(),
                fetch: transport.fetch,
            }).session("images", { instructions: imageContext.instructions });
            try {
                const events = await collect(session.run(testContext, { context: imageContext }));
                if (vendor.Provider === KimiProvider) {
                    expect(events.at(-1)).toMatchObject({ state: "normal" });
                    expect(transport.requests[0]!.body.messages[1]).toEqual({
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: { url: "data:image/png;base64,aW1hZ2U=" },
                            },
                        ],
                    });
                } else {
                    expect(events.at(-1)).toMatchObject({
                        state: "error",
                        message: "GLM 5.3 supports text input only.",
                    });
                    expect(transport.requests).toHaveLength(0);
                }
            } finally {
                session.destroy();
            }
        }
    });
});

async function bearer() {
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "test-bedrock-token",
    });
    if (credential === null) throw new Error("Missing Bedrock test credential.");
    return credential;
}

async function collect(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function mockTransport(
    respond: (attempt: number, init: RequestInit | undefined) => Response | Promise<Response>,
) {
    const requests: {
        url: string;
        method: string;
        headers: Headers;
        redirect: RequestInit["redirect"];
        body: Record<string, any>;
    }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        requests.push({
            url: input instanceof Request ? input.url : String(input),
            method: init?.method ?? "GET",
            headers: new Headers(init?.headers),
            redirect: init?.redirect,
            body: JSON.parse(String(init?.body)),
        });
        return await respond(requests.length - 1, init);
    };
    return { fetch: fetcher, requests };
}

function chunk(delta: object, finish_reason: string | null = null) {
    return { choices: [{ index: 0, delta, finish_reason }] };
}

function sse(chunks: readonly object[]): Response {
    return new Response(
        chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
        {
            headers: { "content-type": "text/event-stream" },
        },
    );
}

function usageChunk() {
    return {
        choices: [],
        usage: {
            prompt_tokens: 120,
            completion_tokens: 18,
            prompt_tokens_details: { cached_tokens: 80 },
        },
    };
}

function answer(text = "Complete."): Response {
    return sse([chunk({ content: text }), chunk({}, "stop"), usageChunk()]);
}

function toolAnswer(): Response {
    return sse([
        chunk({ reasoning_content: "Compare both " }),
        chunk({ reasoning_content: "files." }),
        chunk({ content: "Checking." }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call-read",
                    function: { name: "files__read", arguments: '{"path":' },
                },
                {
                    index: 1,
                    id: "call-search",
                    function: { name: "search", arguments: '{"query":"' },
                },
            ],
        }),
        chunk({
            tool_calls: [
                { index: 1, function: { arguments: 'two"}' } },
                { index: 0, function: { arguments: '"one.ts"}' } },
            ],
        }),
        chunk({}, "tool_calls"),
        usageChunk(),
    ]);
}

function errorResponse(status: number, type: string): Response {
    return new Response(
        JSON.stringify({ error: { message: "Upstream request rejected.", type, code: type } }),
        {
            status,
            headers: { "content-type": "application/json", "x-request-id": "test-request-id" },
        },
    );
}
