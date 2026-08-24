import { testContext } from "../testContext.js";

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";
import { toGrokToolDefinitions } from "@/vendors/grok/impl/toGrokToolDefinitions.js";
import { grok_server_tools } from "@/vendors/grok/tools/index.js";

/**
 * Grok answers a question about X or the web by running the search on its own backend inside one
 * response. These goldens come from real CLI 0.2.118 traffic and pin the two halves that make
 * that work: asking for the server tool, and reading back calls the client must never execute.
 */
describe("Grok server tool goldens", () => {
    it("declares server search the way the captured CLI request does", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const serverTools = golden.request.tools.filter(
            (tool: { type: string }) => tool.type === "web_search" || tool.type === "x_search",
        );
        expect(serverTools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
        expect(toGrokToolDefinitions(grok_server_tools)).toEqual(serverTools);
    });

    it("sends server tools alongside the tools Rig executes", async () => {
        const captured = await captureRequest({ serverTools: grok_server_tools });
        expect(captured.body.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
            { type: "web_search" },
            { type: "x_search" },
        ]);
    });

    it("sends no server tools when a session does not define them", async () => {
        const captured = await captureRequest({});
        expect(captured.body.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
        ]);
    });

    it("leaves server search out of compaction, which has nothing to search for", async () => {
        const captured = await captureRequest({
            serverTools: grok_server_tools,
            compaction: true,
        });
        expect(captured.body.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
        ]);
        expect(captured.body.temperature).toBe(1);
    });

    it("reports a native server call through its configured name and namespace", async () => {
        const captured = await captureRequest({
            serverTools: [
                {
                    name: "SearchWeb",
                    namespace: "search",
                    server: { type: "web_search" },
                },
            ],
            responseEvents: [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_alias",
                        action: { type: "search", query: "Rig" },
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "web_search_call",
                                id: "ws_alias",
                                status: "completed",
                                action: { type: "search", query: "Rig" },
                            },
                        ],
                        usage: { total_tokens: 1 },
                    },
                },
            ],
        });

        expect(captured.events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_start",
                callId: "ws_alias",
                name: "SearchWeb",
                namespace: "search",
                server: true,
            }),
        );
    });

    it("reports captured X search as provider-executed rather than a call Rig must answer", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const { events, result } = await replay(golden);

        expect(serverToolCallStarts(events).map((event) => event.name)).toEqual([
            "x_keyword_search",
            "x_semantic_search",
        ]);
        expect(serverToolCallEnds(events).map((event) => JSON.parse(event.arguments))).toEqual([
            { query: "Claude Code", limit: "5", mode: "Latest" },
            { query: "Claude Code", limit: "5" },
        ]);

        // The client is never asked to run these, so the turn is a finished answer, not a tool loop.
        expect(
            events.filter((event) => event.type === "toolcall_start" && event.server !== true),
        ).toEqual([]);
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(result.assistantText).toContain("https://x.com/");
    });

    it("reports captured web search as provider-executed and keeps its queried sources", async () => {
        const golden = await fixture("grok-4-5-web-search.sse.json");
        const { events, result } = await replay(golden);

        expect(serverToolCallStarts(events).map((event) => event.name)).toEqual(["web_search"]);
        const ended = serverToolCallEnds(events)[0]!;
        const action = JSON.parse(ended.arguments);
        expect(action).toMatchObject({
            type: "search",
            query: "Node.js current stable version",
        });
        // The sources xAI consulted ride on the call for replay and also stream as result events
        // so a surface can render citations without re-parsing the arguments.
        expect(action.sources).toEqual([
            { type: "url", url: "https://nodejs.org/en/about/previous-releases" },
            { type: "url", url: "https://nodejs.org/en" },
            { type: "url", url: "https://en.wikipedia.org/wiki/Node.js" },
            { type: "url", url: "https://nodejs.org/en/download/current" },
            {
                type: "url",
                url: "https://www.herodevs.com/blog-posts/node-js-end-of-life-dates-you-should-be-aware-of",
            },
        ]);
        expect(serverToolCallResults(events)).toEqual([
            {
                callId: ended.callId,
                result: JSON.stringify(action.sources),
            },
        ]);
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
    });

    it("replays server calls verbatim without inventing tool output for them", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const { result } = await replay(golden);

        const input = toGrokResponseInput({
            instructions: "System prompt.",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text" as const,
                            text: "Search X for the latest posts about 'Claude Code'.",
                        },
                    ],
                },
                result.message,
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Who posted first?" }],
                },
            ],
        });

        // Grok carries the search results in its own encrypted reasoning, so the server calls
        // return exactly as they arrived and nothing pairs a fabricated output with them.
        const serverCalls = input.filter(
            (item: any) => item.type === "custom_tool_call" && item.name.startsWith("x_"),
        );
        expect(serverCalls.map((item: any) => item.name)).toEqual([
            "x_keyword_search",
            "x_semantic_search",
        ]);
        expect(input.filter((item: any) => item.type === "custom_tool_call_output")).toEqual([]);
        expect(input.filter((item: any) => item.type === "function_call_output")).toEqual([]);
    });

    it("closes a server call the model truncated, so the search still reaches history", async () => {
        const events: SessionEvent[] = [];
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_1",
                        name: "x_keyword_search",
                        input: "",
                    },
                },
                {
                    type: "response.custom_tool_call_input.delta",
                    output_index: 0,
                    delta: '{"query":"Claude Code"',
                },
                {
                    type: "response.incomplete",
                    response: {
                        incomplete_details: { reason: "max_output_tokens" },
                        output: [],
                        usage: { total_tokens: 5 },
                    },
                },
            ]),
            {
                failureMessage: "unused",
                vendor: "grok",
                serverToolNames: new Set(["x_search"]),
            },
        );
        let next = await mapped.next();
        while (next.done !== true) {
            events.push(next.value);
            next = await mapped.next();
        }

        // Its completion is what becomes a history row, so a truncated turn must still emit one.
        // The name it carried is only ever reported on the start that opened the call.
        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "xs_1",
            name: "x_keyword_search",
            server: true,
        });
        expect(events).toContainEqual({
            type: "toolcall_end",
            callId: "xs_1",
            incomplete: true,
            arguments: '{"query":"Claude Code"',
        });
        // It is still nothing the client has to run.
        expect(next.value.toolCalls).toEqual([]);
        expect(next.value.stopReason).toBe("length");
    });

    it("keeps a completed server result complete when only the surrounding response truncated", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.incomplete",
                    response: {
                        incomplete_details: { reason: "max_output_tokens" },
                        output: [
                            {
                                type: "web_search_call",
                                id: "ws_complete",
                                status: "completed",
                                action: { type: "search", query: "Rig" },
                            },
                        ],
                        usage: { total_tokens: 3 },
                    },
                },
            ],
            { serverToolNames: new Set(["web_search"]) },
        );

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "ws_complete",
            name: "web_search",
            server: true,
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_end",
                callId: "ws_complete",
                arguments: '{"type":"search","query":"Rig"}',
            }),
        );
        expect(
            events.find((event) => event.type === "toolcall_end" && event.callId === "ws_complete"),
        ).not.toHaveProperty("incomplete");
        expect(result.stopReason).toBe("length");
    });

    it("trusts the provider's own marking over a client tool that shares the name", async () => {
        // Rig would never name a tool this, but if it did, only the provider's reserved call-id
        // prefix still says who ran it. Executing a local tool here would answer a call nobody
        // asked Rig to answer, and drop the search the model actually performed.
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_call-1",
                        name: "x_keyword_search",
                        input: "",
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_call-1",
                        name: "x_keyword_search",
                        input: '{"query":"Claude Code"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            {
                serverToolNames: new Set(["x_search"]),
            },
        );

        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "xs_call-1",
            name: "x_keyword_search",
            server: true,
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_end",
                callId: "xs_call-1",
                arguments: '{"query":"Claude Code"}',
            }),
        );
    });

    it("rejects a malformed custom call before invalid fields reach durable events", async () => {
        await expect(
            replayEvents(
                [
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "custom_tool_call",
                            call_id: "xs_call-1",
                            name: 17,
                            input: '{"query":"anything"}',
                        },
                    },
                ],
                { serverToolNames: new Set(["x_search"]) },
            ),
        ).rejects.toThrow("Provider returned a malformed custom_tool_call output item.");
    });

    it("still runs a client tool the provider did not mark as its own", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "format_document",
                        input: '{"path":"a.ts"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            {
                serverToolNames: new Set(["x_search"]),
            },
        );

        expect(result.toolCalls.map((call) => call.name)).toEqual(["format_document"]);
        expect(result.stopReason).toBe("tool_use");
        expect(
            events.some((event) => event.type === "toolcall_start" && event.server === true),
        ).toBe(false);
    });

    // A name nobody declared is a model mistake, and the model has to hear about it. Reading it
    // as work the provider already did would report a search that never happened and leave the
    // model waiting for an answer to a call Rig deliberately never executes.
    it("hands an invented tool name back to the client rather than calling it the provider's", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "search_the_internet",
                        input: '{"query":"anything"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            { serverToolNames: new Set(["web_search", "x_search"]) },
        );

        expect(result.toolCalls.map((call) => call.name)).toEqual(["search_the_internet"]);
        expect(result.stopReason).toBe("tool_use");
        expect(
            events.some((event) => event.type === "toolcall_start" && event.server === true),
        ).toBe(false);
    });

    it("treats every tool call as the client's when no server tool was requested", async () => {
        // Compaction sends no server tools, so a call during it must still invalidate the sample.
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "x_keyword_search",
                        input: "",
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "x_keyword_search",
                        input: '{"query":"anything"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            {},
        );

        expect(result.toolCalls.map((call) => call.name)).toEqual(["x_keyword_search"]);
        expect(result.stopReason).toBe("tool_use");
        expect(
            events.some((event) => event.type === "toolcall_start" && event.server === true),
        ).toBe(false);
    });

    it("reports a server call that only ever appears in the terminal response", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "web_search_call",
                                id: "ws-1",
                                status: "completed",
                                action: { type: "search", query: "Node.js release" },
                            },
                        ],
                        usage: { total_tokens: 3 },
                    },
                },
            ],
            { serverToolNames: new Set(["web_search"]) },
        );

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "ws-1",
            name: "web_search",
            server: true,
        });
        const ended = serverToolCallEnds(events)[0]!;
        expect(JSON.parse(ended.arguments)).toMatchObject({ query: "Node.js release" });
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
    });

    it("prefers the terminal arguments when a server call never streamed its own completion", async () => {
        const { events } = await replayEvents(
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_1",
                        name: "x_keyword_search",
                        input: "",
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "custom_tool_call",
                                call_id: "xs_1",
                                name: "x_keyword_search",
                                input: '{"query":"Claude Code","limit":"5"}',
                            },
                        ],
                        usage: { total_tokens: 3 },
                    },
                },
            ],
            {
                serverToolNames: new Set(["x_search"]),
            },
        );

        // Exactly one pair, carrying the arguments the terminal payload settled.
        expect(serverToolCallStarts(events)).toHaveLength(1);
        expect(serverToolCallEnds(events)).toEqual([
            expect.objectContaining({
                type: "toolcall_end",
                callId: "xs_1",
                arguments: '{"query":"Claude Code","limit":"5"}',
            }),
        ]);
    });

    it("keeps an undeclared custom tool executable when the client declared no tool names", async () => {
        const events: SessionEvent[] = [];
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "grammar_tool",
                        input: "",
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "grammar_tool",
                        input: "print(1)",
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ]),
            { failureMessage: "unused" },
        );
        let next = await mapped.next();
        while (next.done !== true) {
            events.push(next.value);
            next = await mapped.next();
        }
        expect(next.value.toolCalls.map((call) => call.name)).toEqual(["grammar_tool"]);
        expect(
            events.some((event) => event.type === "toolcall_start" && event.server === true),
        ).toBe(false);
    });

    it("settles multiple server calls and terminal text before ending a mixed client batch", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_1",
                        name: "x_keyword_search",
                        input: '{"query":"Rig"}',
                    },
                },
                {
                    type: "response.output_item.added",
                    output_index: 1,
                    item: {
                        type: "web_search_call",
                        id: "ws_1",
                        action: { type: "search", query: "Rig releases" },
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 2,
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "read_file",
                        arguments: '{"path":"README.md"}',
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "custom_tool_call",
                                call_id: "xs_1",
                                name: "x_keyword_search",
                                input: '{"query":"Rig"}',
                            },
                            {
                                type: "web_search_call",
                                id: "ws_1",
                                action: { type: "search", query: "Rig releases" },
                            },
                            {
                                type: "message",
                                role: "assistant",
                                content: [{ type: "output_text", text: "I found both sources." }],
                            },
                        ],
                        usage: { total_tokens: 3 },
                    },
                },
            ],
            { serverToolNames: new Set(["web_search", "x_search"]) },
        );

        expect(serverToolCallEnds(events)).toHaveLength(2);
        expect(events).toContainEqual({ type: "text_delta", delta: "I found both sources." });
        expect(result.assistantText).toBe("I found both sources.");
        expect(result.toolCalls.map((call) => call.name)).toEqual(["read_file"]);
        expect(result.stopReason).toBe("tool_use");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
    });

    it("closes an open server call when the user aborts the response", async () => {
        const abort = new AbortController();
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "xs_abort",
                        name: "x_semantic_search",
                        input: '{"query":"partial"}',
                    },
                },
                {
                    type: "response.custom_tool_call_input.delta",
                    output_index: 0,
                    delta: " never consumed",
                },
            ]),
            {
                failureMessage: "unused",
                signal: abort.signal,
                serverToolNames: new Set(["x_search"]),
            },
        );

        await expect(mapped.next()).resolves.toMatchObject({
            value: { type: "toolcall_start", callId: "xs_abort", server: true },
        });
        abort.abort();
        await expect(mapped.next()).resolves.toMatchObject({
            value: {
                type: "toolcall_delta",
                callId: "xs_abort",
                delta: '{"query":"partial"}',
            },
        });
        await expect(mapped.next()).resolves.toMatchObject({
            value: {
                type: "toolcall_end",
                callId: "xs_abort",
                arguments: '{"query":"partial"}',
            },
        });
        await expect(mapped.next()).resolves.toMatchObject({ done: true });
    });

    it("closes an open server call before surfacing provider failure", async () => {
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_fail",
                        action: { type: "search", query: "partial" },
                    },
                },
                { type: "error", code: null, message: "provider failed", param: null },
            ]),
            {
                failureMessage: "unused",
                serverToolNames: new Set(["web_search"]),
            },
        );

        await mapped.next();
        await expect(mapped.next()).resolves.toMatchObject({
            value: { type: "toolcall_end", callId: "ws_fail" },
        });
        await expect(mapped.next()).rejects.toThrow("provider failed");
    });

    it("closes an open server call before surfacing an iterator transport failure", async () => {
        const mapped = mapOpenAIResponseStream(
            (async function* () {
                yield {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_disconnect",
                        action: { type: "search", query: "partial" },
                    },
                } as never;
                throw new Error("transport disconnected");
            })(),
            {
                failureMessage: "unused",
                serverToolNames: new Set(["web_search"]),
            },
        );

        await expect(mapped.next()).resolves.toMatchObject({
            value: { type: "toolcall_start", callId: "ws_disconnect", server: true },
        });
        await expect(mapped.next()).resolves.toMatchObject({
            value: {
                type: "toolcall_end",
                callId: "ws_disconnect",
                incomplete: true,
            },
        });
        await expect(mapped.next()).rejects.toThrow("transport disconnected");
    });

    it("commits a queued terminal response even when abort arrives first", async () => {
        const abort = new AbortController();
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_terminal_race",
                        action: { type: "search", query: "Rig" },
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "web_search_call",
                                id: "ws_terminal_race",
                                status: "completed",
                                action: { type: "search", query: "Rig" },
                            },
                            {
                                type: "message",
                                content: [{ type: "output_text", text: "Terminal answer." }],
                            },
                        ],
                        usage: { total_tokens: 4 },
                    },
                },
            ]),
            {
                failureMessage: "unused",
                signal: abort.signal,
                serverToolNames: new Set(["web_search"]),
            },
        );

        await mapped.next();
        abort.abort();
        let next = await mapped.next();
        const events = [];
        while (next.done !== true) {
            events.push(next.value);
            next = await mapped.next();
        }

        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_end",
                callId: "ws_terminal_race",
                arguments: '{"type":"search","query":"Rig"}',
            }),
        );
        expect(next.value.assistantText).toBe("Terminal answer.");
        expect(next.value.stopReason).toBe("stop");
    });

    it("scopes fallback server-call IDs to one response", async () => {
        const terminal = [
            {
                type: "response.completed",
                response: {
                    output: [
                        {
                            type: "web_search_call",
                            action: { type: "search", query: "missing id" },
                        },
                    ],
                    usage: { total_tokens: 1 },
                },
            },
        ];
        const first = await replayEvents(terminal, {
            serverToolNames: new Set(["web_search"]),
        });
        const second = await replayEvents(terminal, {
            serverToolNames: new Set(["web_search"]),
        });
        const firstId = serverToolCallEnds(first.events)[0]?.callId;
        const secondId = serverToolCallEnds(second.events)[0]?.callId;

        expect(firstId).toMatch(/^server_tool_call_/u);
        expect(secondId).toMatch(/^server_tool_call_/u);
        expect(firstId).not.toBe(secondId);
    });

    it("marks a failed native search incomplete instead of reporting success", async () => {
        const { events } = await replayEvents(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_failed",
                        status: "failed",
                        action: { type: "search", query: "Rig" },
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            { serverToolNames: new Set(["web_search"]) },
        );

        expect(events).toContainEqual(
            expect.objectContaining({
                type: "toolcall_end",
                callId: "ws_failed",
                arguments: '{"type":"search","query":"Rig"}',
                incomplete: true,
            }),
        );
    });

    it("rejects a malformed supplied server-call id", async () => {
        await expect(
            replayEvents(
                [
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "web_search_call",
                            id: 17,
                            status: "completed",
                            action: { type: "search", query: "Rig" },
                        },
                    },
                ],
                { serverToolNames: new Set(["web_search"]) },
            ),
        ).rejects.toThrow("Provider returned a malformed web_search_call output item.");
    });

    it("rejects a malformed native search action", async () => {
        await expect(
            replayEvents(
                [
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "web_search_call",
                            id: "ws_malformed",
                            status: "completed",
                            action: null,
                        },
                    },
                ],
                { serverToolNames: new Set(["web_search"]) },
            ),
        ).rejects.toThrow("Provider returned a malformed web_search_call output item.");
    });

    it("keeps a client call that appears only in the terminal mixed response", async () => {
        const { events, result } = await replayEvents(
            [
                {
                    type: "response.completed",
                    response: {
                        output: [
                            {
                                type: "web_search_call",
                                id: "ws_terminal",
                                action: { type: "search", query: "Rig" },
                            },
                            {
                                type: "function_call",
                                call_id: "call_terminal",
                                name: "read_file",
                                arguments: '{"path":"README.md"}',
                            },
                        ],
                        usage: { total_tokens: 2 },
                    },
                },
            ],
            { serverToolNames: new Set(["web_search"]) },
        );

        expect(serverToolCallEnds(events)).toHaveLength(1);
        expect(result.toolCalls.map((call) => call.name)).toEqual(["read_file"]);
        expect(result.stopReason).toBe("tool_use");
    });
});

/** Every `toolcall_start` the provider marked `server: true`, in emission order. */
function serverToolCallStarts(
    events: readonly SessionEvent[],
): (Extract<SessionEvent, { type: "toolcall_start" }> & { server: true })[] {
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_start" }> & { server: true } =>
            event.type === "toolcall_start" && event.server === true,
    );
}

/** Provider-owned results that followed a server tool call, in emission order. */
function serverToolCallResults(
    events: readonly SessionEvent[],
): { callId: string; result: string }[] {
    const serverCallIds = new Set(serverToolCallStarts(events).map((event) => event.callId));
    return events.flatMap((event) =>
        event.type === "toolcall_result_end" && serverCallIds.has(event.callId)
            ? [
                  {
                      callId: event.callId,
                      result: event.content
                          .filter((block) => block.type === "text")
                          .map((block) => block.text)
                          .join(""),
                  },
              ]
            : [],
    );
}

/** `toolcall_end` events belonging to a call the provider started itself, in emission order. */
function serverToolCallEnds(
    events: readonly SessionEvent[],
): Extract<SessionEvent, { type: "toolcall_end" }>[] {
    const serverCallIds = new Set(serverToolCallStarts(events).map((event) => event.callId));
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_end" }> =>
            event.type === "toolcall_end" && serverCallIds.has(event.callId),
    );
}

const readFileTool: SessionTool = {
    name: "read_file",
    description: "Read a file.",
};

/** Maps a hand-built event sequence and returns both the events and the run result. */
async function replayEvents(
    events: readonly unknown[],
    options: { serverToolNames?: ReadonlySet<string> },
) {
    const mapped = mapOpenAIResponseStream(stream(events), {
        failureMessage: "unused",
        vendor: "grok",
        ...options,
    });
    const collected: SessionEvent[] = [];
    let next = await mapped.next();
    while (next.done !== true) {
        collected.push(next.value);
        next = await mapped.next();
    }
    return { events: collected, result: next.value };
}

async function replay(golden: any) {
    const events: SessionEvent[] = [];
    const mapped = mapOpenAIResponseStream(stream(golden.response.events), {
        failureMessage: "Captured Grok response failed.",
        requireTerminalEvent: true,
        vendor: "grok",
        serverToolNames: new Set(["web_search", "x_search"]),
    });
    let next = await mapped.next();
    while (next.done !== true) {
        events.push(next.value);
        next = await mapped.next();
    }
    return { events, result: next.value };
}

/** Runs one Grok session against a local endpoint and returns the request body it sent. */
async function captureRequest(options: {
    serverTools?: readonly SessionTool[];
    compaction?: boolean;
    responseEvents?: readonly unknown[];
}) {
    let capturedBody: any;
    const events: SessionEvent[] = [];
    const summary = `<summary>${"Summarized session state. ".repeat(40)}</summary>`;
    const server = createServer(async (request, response) => {
        capturedBody = JSON.parse(await readBody(request));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const responseEvents = options.responseEvents ?? [
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg", role: "assistant", content: [] },
            },
            {
                type: "response.output_text.delta",
                output_index: 0,
                delta: summary,
            },
            {
                type: "response.completed",
                response: { id: "response", output: [], usage: { total_tokens: 1 } },
            },
        ];
        response.end(`${responseEvents.map(sse).join("")}data: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    try {
        const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
        if (credential === null) throw new Error("Missing test credential.");
        const provider = new GrokProvider({
            credential,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            model: "grok-4.5",
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: "System prompt.",
            tools: [readFileTool, ...(options.serverTools ?? [])],
        });
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Hi." }],
                    },
                ],
            },
        })) {
            events.push(event);
        }
        if (options.compaction === true) {
            capturedBody = undefined;
            const compacted = await session.compact(testContext, {
                context: {
                    instructions: "System prompt.",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Hi." }],
                        },
                    ],
                },
            });
            expect(compacted.status).toBe("completed");
        }
        return { body: capturedBody, events };
    } finally {
        server.close();
    }
}

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => resolve(body));
        request.once("error", reject);
    });
}

async function* stream(events: readonly unknown[]): AsyncIterable<any> {
    for (const event of events) yield event;
}

function sse(event: unknown): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}
