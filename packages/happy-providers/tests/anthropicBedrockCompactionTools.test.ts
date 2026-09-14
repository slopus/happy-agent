import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import type { SessionContext } from "@/core/SessionContext.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { AnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { testContext } from "./testContext.js";

const model = "anthropic/fable-5-1";
const tools: readonly SessionTool[] = [
    {
        name: "ToolSearch",
        server: { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    },
    {
        name: "web_fetch",
        description: "Read a web page.",
        parameters: Type.Object({ url: Type.String() }),
        defer: true,
    },
];
const searchCall = {
    type: "server_tool_use",
    id: "search-1",
    name: "tool_search_tool_bm25",
    input: { query: "read a web page" },
};
const searchResult = {
    type: "tool_search_tool_result",
    tool_use_id: "search-1",
    content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "web_fetch" }],
    },
};
const checkpoint = {
    type: "compaction",
    content: "The conversation discovered web_fetch.",
    encrypted_content: "opaque-native-checkpoint",
};

describe("Bedrock native compaction with discovered tools", () => {
    it.each(["session", "selected model"] as const)(
        "retains %s tools through compaction and checkpoint continuation",
        async (toolSource) => {
            const requests: AnthropicRequest[] = [];
            const client = new AnthropicBedrockMantle({
                apiKey: "test-only-placeholder",
                awsRegion: "us-east-1",
                maxRetries: 0,
                fetch: async (_url, init) => {
                    const request = JSON.parse(String(init?.body)) as AnthropicRequest;
                    requests.push(request);
                    const compacting = request.context_management?.edits?.some(
                        (edit) => edit.type === "compact_20260112" && edit.pause_after_compaction,
                    );
                    if (compacting) {
                        // Reproduce the observed upstream validation failure through the real SDK.
                        if (
                            !request.tools?.some((tool) =>
                                Value.Check(Type.Object({ name: Type.Literal("web_fetch") }), tool),
                            )
                        ) {
                            return new Response(
                                JSON.stringify({
                                    type: "error",
                                    error: {
                                        type: "invalid_request_error",
                                        message:
                                            "Tool reference 'web_fetch' not found in available tools",
                                    },
                                }),
                                { status: 400, headers: { "content-type": "application/json" } },
                            );
                        }
                        return response([checkpoint], "compaction");
                    }
                    return requests.length === 1
                        ? response([searchCall, searchResult, { type: "text", text: "Ready." }])
                        : response([{ type: "text", text: "Continued." }]);
                },
            });
            const credential = await BedrockBearerTokenCredential.tryLoad({
                bearerToken: "test-only-placeholder",
            });
            if (credential === null) throw new Error("Expected a test credential.");
            const provider = new AnthropicBedrockProvider({
                client,
                credential,
                model: toolSource === "session" ? model : "anthropic/opus-4-8",
                inferenceMaxRetries: 0,
            });
            const session = await provider.session("compaction-tool-references", {
                instructions: "Keep the conversation intact.",
                tools: toolSource === "session" ? tools : [],
                ...(toolSource === "session"
                    ? {}
                    : {
                          modelConfigurations: {
                              [model]: { instructions: "Selected model.", tools },
                          },
                      }),
            });
            try {
                const initial: SessionContext = {
                    instructions: "Keep the conversation intact.",
                    messages: [
                        { role: "user", content: [{ type: "text", text: "Find a web tool." }] },
                    ],
                };
                const events: SessionEvent[] = [];
                for await (const event of session.run(testContext, { context: initial, model })) {
                    events.push(event);
                }
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                const assistant = assistantMessageFromEvents(events);
                if (assistant === undefined) throw new Error("Expected the tool-search response.");
                const context: SessionContext = {
                    ...initial,
                    messages: [...initial.messages, assistant],
                };
                const before = structuredClone(context);

                const result = await session.compact(testContext, { context });

                expect(result, JSON.stringify(result)).toMatchObject({
                    status: "completed",
                    compaction: {
                        role: "compaction",
                        content: checkpoint.content,
                        encryptedContent: checkpoint.encrypted_content,
                    },
                });
                expect(context).toEqual(before);
                expect(requests).toHaveLength(2);
                expect(requests[1]?.tools).toEqual(requests[0]?.tools);
                expect(requests[1]?.tools).toContainEqual(
                    expect.objectContaining({ name: "web_fetch", defer_loading: true }),
                );
                expect(requests[1]?.messages[1]?.content).toEqual(
                    expect.arrayContaining([searchCall, searchResult]),
                );
                expect(requests[1]?.model).toBe("anthropic.claude-fable-5-1");
                expect(requests[1]?.context_management?.edits).toContainEqual(
                    expect.objectContaining({
                        type: "compact_20260112",
                        pause_after_compaction: true,
                    }),
                );
                if (result.status !== "completed") throw new Error("Expected native compaction.");

                const continued: SessionEvent[] = [];
                for await (const event of session.run(testContext, {
                    context: {
                        ...result.context,
                        messages: [
                            ...result.context.messages,
                            { role: "user", content: [{ type: "text", text: "Continue." }] },
                        ],
                    },
                })) {
                    continued.push(event);
                }
                expect(continued.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(continued).toContainEqual({ type: "text_delta", delta: "Continued." });
                expect(requests).toHaveLength(3);
                expect(requests[2]?.tools).toEqual(requests[0]?.tools);
                expect(requests[2]?.messages[0]?.content).toEqual([
                    { ...checkpoint, cache_control: { type: "ephemeral" } },
                ]);
            } finally {
                session.destroy();
            }
        },
    );
});

function response(blocks: readonly unknown[], stopReason = "end_turn"): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg-compaction-tools",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 333_084, output_tokens: 1 },
            },
        },
        ...blocks.flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
        ]),
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 10 },
        },
        { type: "message_stop" },
    ];
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    );
}
