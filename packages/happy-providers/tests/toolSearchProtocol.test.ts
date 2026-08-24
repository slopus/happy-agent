import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toAnthropicTools } from "@/protocol/anthropic/toAnthropicTools.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { toResponsesToolDefinitions } from "@/protocol/responses/toResponsesToolDefinitions.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { toGrokToolDefinitions } from "@/vendors/grok/impl/toGrokToolDefinitions.js";

const deferredTool: SessionTool = {
    name: "rare_tool",
    description: "Perform a rare operation.",
    parameters: Type.Object({ query: Type.String() }),
    searchKeywords: ["uncommon", "specialized"],
    defer: true,
};

describe("provider-owned tool search", () => {
    it.each([
        ["tool_search_tool_bm25", "tool_search_tool_bm25"],
        ["tool_search_tool_bm25_20251119", "tool_search_tool_bm25"],
        ["tool_search_tool_regex", "tool_search_tool_regex"],
        ["tool_search_tool_regex_20251119", "tool_search_tool_regex"],
    ] as const)("passes Anthropic %s through and defers client tools", (type, name) => {
        const server = { type, name, strict: true };
        const request = createAnthropicRequest({
            context: {
                instructions: "Use the available tools.",
                messages: [{ role: "user", content: [{ type: "text", text: "Find a tool." }] }],
            },
            model: "anthropic.claude-opus-4-8",
            tools: [{ name: "ToolSearch", server }, deferredTool],
        });

        expect(request.betas).toContain("tool-search-tool-2025-10-19");
        expect(request.tools?.[0]).toEqual(server);
        expect(request.tools?.[1]).toMatchObject({
            name: "rare_tool",
            defer_loading: true,
        });
    });

    it("eagerly includes deferred tools when Anthropic tool search is absent", () => {
        const request = createAnthropicRequest({
            context: {
                instructions: "Use the available tools.",
                messages: [{ role: "user", content: [{ type: "text", text: "Use a tool." }] }],
            },
            model: "anthropic.claude-opus-4-8",
            tools: [deferredTool],
        });

        expect(request.betas).not.toContain("tool-search-tool-2025-10-19");
        expect(request.tools).toEqual([expect.not.objectContaining({ defer_loading: true })]);
    });

    it("continues to reject unrelated Anthropic Bedrock server tools", () => {
        expect(() =>
            toAnthropicTools([{ name: "WebSearch", server: { type: "web_search_20250305" } }]),
        ).toThrow("does not support server tool 'WebSearch'");
    });

    it("keeps Grok server descriptors opaque and eagerly includes deferred tools", () => {
        const definitions = toGrokToolDefinitions([
            { name: "responses_search", server: { type: "tool_search" } },
            { name: "web_search", server: { type: "web_search" } },
            deferredTool,
        ]);

        expect(definitions).toEqual([
            { type: "tool_search" },
            { type: "web_search" },
            expect.objectContaining({ type: "function", name: "rare_tool" }),
        ]);
        expect(definitions).not.toContainEqual(expect.objectContaining({ defer_loading: true }));
    });

    it("classifies search support by native descriptor instead of the outer tool name", () => {
        const namedLikeSearch: SessionTool = {
            name: "ToolSearch",
            server: { type: "web_search" },
        };
        expect(toGrokToolDefinitions([namedLikeSearch])).toEqual([{ type: "web_search" }]);
        expect(toResponsesToolDefinitions([namedLikeSearch])).toEqual([{ type: "web_search" }]);
    });

    it("rejects invalid execution modes at the native provider boundary", () => {
        const invalid = {
            name: "tool_search",
            server: { type: "tool_search", execution: "elsewhere" },
        } as const satisfies SessionTool;

        expect(() => toCodexToolDefinitions([invalid])).toThrow(
            "Codex tool_search execution must be 'client' or 'server'.",
        );
        expect(() => toResponsesToolDefinitions([invalid])).toThrow(
            "Responses tool_search execution must be 'client' or 'server'.",
        );
    });

    it.each([undefined, "server"] as const)(
        "uses generic Responses hosted search when execution is %s",
        (execution) => {
            const server = {
                type: "tool_search" as const,
                ...(execution === undefined ? {} : { execution }),
            };
            const definitions = toResponsesToolDefinitions([
                { name: "tool_search", server },
                deferredTool,
            ]);

            expect(definitions[0]).toEqual(server);
            expect(definitions[1]).toMatchObject({
                type: "function",
                name: "rare_tool",
                defer_loading: true,
            });
        },
    );

    it("falls back to eager generic Responses tools for client-executed search", () => {
        const definitions = toResponsesToolDefinitions([
            {
                name: "client_search",
                server: { type: "tool_search", execution: "client" },
            },
            { name: "web_search", server: { type: "web_search" } },
            deferredTool,
        ]);

        expect(definitions).toEqual([
            { type: "web_search" },
            expect.objectContaining({ type: "function", name: "rare_tool" }),
        ]);
        expect(definitions).not.toContainEqual(expect.objectContaining({ defer_loading: true }));
    });

    it("round-trips Anthropic native search calls and results exactly", async () => {
        const streamedCallBlock = {
            type: "server_tool_use",
            id: "search-call",
            name: "tool_search_tool_bm25",
            input: {},
        };
        const callBlock = {
            ...streamedCallBlock,
            input: { query: "rare operation" },
        };
        const resultBlock = {
            type: "tool_search_tool_result",
            tool_use_id: "search-call",
            content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "rare_tool" }],
            },
        };
        const events: SessionEvent[] = [];
        for await (const event of mapAnthropicStream(
            anthropicToolSearchStream(streamedCallBlock, resultBlock, '{"query":"rare operation"}'),
            {
                tools: [
                    {
                        name: "ToolSearch",
                        server: {
                            type: "tool_search_tool_bm25_20251119",
                            name: "tool_search_tool_bm25",
                        },
                    },
                    deferredTool,
                ],
            },
        )) {
            events.push(event);
        }

        const message = assistantMessageFromEvents(events);
        expect(message).toBeDefined();
        expect(message?.content).toMatchObject([
            {
                type: "tool_call",
                callId: "search-call",
                name: "ToolSearch",
                server: true,
                vendor: { outputBlock: JSON.stringify(callBlock) },
            },
            {
                type: "tool_result",
                callId: "search-call",
                vendor: { outputBlock: JSON.stringify(resultBlock) },
            },
        ]);
        expect(toAnthropicMessages([message!])[0]?.content).toEqual([callBlock, resultBlock]);
    });

    it("round-trips generic hosted search call and output items exactly", async () => {
        const call = {
            type: "tool_search_call",
            id: "search-item",
            call_id: "search-call",
            execution: "server",
            status: "completed",
            arguments: { query: "rare operation" },
        };
        const output = {
            type: "tool_search_output",
            id: "search-output",
            call_id: "search-call",
            execution: "server",
            status: "completed",
            tools: [{ type: "function", name: "rare_tool" }],
        };
        const mapped = mapOpenAIResponseStream(responsesToolSearchStream(call, output), {
            failureMessage: "unused",
            requireTerminalEvent: true,
            vendor: "responses",
            serverToolNames: new Set(["tool_search"]),
            serverToolDisplayNames: new Map([["tool_search", "discover_tools"]]),
            serverToolDisplayNamespaces: new Map([["tool_search", "search"]]),
        });
        const events: SessionEvent[] = [];
        let result: Awaited<ReturnType<typeof mapped.next>>["value"];
        for (;;) {
            const next = await mapped.next();
            if (next.done) {
                result = next.value;
                break;
            }
            events.push(next.value);
        }

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "search-call",
            name: "discover_tools",
            namespace: "search",
            server: true,
            vendor: {
                provider: "responses",
                type: "server_tool_call",
                nativeType: "tool_search_call",
            },
        });
        expect(events).toContainEqual({
            type: "toolcall_result_delta",
            callId: "search-call",
            delta: JSON.stringify(output.tools),
        });
        if (result === undefined || !("message" in result)) expect.fail("Missing mapped result.");
        expect(result.toolCalls).toEqual([]);
        expect(toOpenAIResponseInput({ instructions: "", messages: [result.message] })).toEqual([
            call,
            output,
        ]);
        const persisted = assistantMessageFromEvents([
            { type: "block_start" },
            ...events,
            { type: "block_stop" },
        ]);
        expect(persisted).toBeDefined();
        expect(toOpenAIResponseInput({ instructions: "", messages: [persisted!] })).toEqual([
            call,
            output,
        ]);
    });

    it("pairs hosted search calls and outputs whose native call IDs are null", async () => {
        const call = {
            type: "tool_search_call",
            id: "search-item",
            call_id: null,
            execution: "server",
            status: "completed",
            arguments: { query: "rare operation" },
        };
        const output = {
            type: "tool_search_output",
            id: "search-output",
            call_id: null,
            execution: "server",
            status: "completed",
            tools: [{ type: "function", name: "rare_tool" }],
        };
        const mapped = mapOpenAIResponseStream(responsesToolSearchStream(call, output), {
            failureMessage: "unused",
            requireTerminalEvent: true,
            vendor: "responses",
            serverToolNames: new Set(["tool_search"]),
        });
        const events: SessionEvent[] = [];
        let result: Awaited<ReturnType<typeof mapped.next>>["value"];
        for (;;) {
            const next = await mapped.next();
            if (next.done) {
                result = next.value;
                break;
            }
            events.push(next.value);
        }

        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_start",
                callId: "search-item",
                name: "tool_search",
                server: true,
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_result_end",
                callId: "search-item",
            }),
        );
        if (result === undefined || !("message" in result)) expect.fail("Missing mapped result.");
        expect(toOpenAIResponseInput({ instructions: "", messages: [result.message] })).toEqual([
            call,
            output,
        ]);
    });
});

async function* anthropicToolSearchStream(
    callBlock: unknown,
    resultBlock: unknown,
    argumentsDelta?: string,
): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield {
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
    } as BetaRawMessageStreamEvent;
    yield {
        type: "content_block_start",
        index: 0,
        content_block: callBlock,
    } as BetaRawMessageStreamEvent;
    if (argumentsDelta !== undefined) {
        yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: argumentsDelta },
        } as BetaRawMessageStreamEvent;
    }
    yield { type: "content_block_stop", index: 0 } as BetaRawMessageStreamEvent;
    yield {
        type: "content_block_start",
        index: 1,
        content_block: resultBlock,
    } as BetaRawMessageStreamEvent;
    yield { type: "content_block_stop", index: 1 } as BetaRawMessageStreamEvent;
    yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
    } as BetaRawMessageStreamEvent;
    yield { type: "message_stop" } as BetaRawMessageStreamEvent;
}

async function* responsesToolSearchStream(call: unknown, output: unknown): AsyncGenerator<any> {
    yield { type: "response.output_item.added", output_index: 0, item: call };
    yield { type: "response.output_item.done", output_index: 0, item: call };
    yield { type: "response.output_item.added", output_index: 1, item: output };
    yield { type: "response.output_item.done", output_index: 1, item: output };
    yield {
        type: "response.completed",
        response: {
            id: "response",
            output: [call, output],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
    };
}
