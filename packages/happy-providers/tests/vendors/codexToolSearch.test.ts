import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { SessionTool } from "@/core/SessionTool.js";
import { searchCodexTools } from "@/vendors/codex/impl/searchCodexTools.js";
import { settleCodexToolSearch } from "@/vendors/codex/impl/settleCodexToolSearch.js";

const tools = [
    {
        name: "calendar_create_event",
        description: "Create a meeting on a calendar.",
        parameters: Type.Object({
            timezone: Type.String({ description: "IANA timezone for the event." }),
        }),
        defer: true,
    },
    {
        name: "repository_search",
        description: "Find source code in a repository.",
        parameters: Type.Object({ query: Type.String() }),
        defer: true,
    },
    {
        name: "music_lookup",
        description: "Find songs and albums.",
        parameters: Type.Object({}),
        defer: true,
    },
] as const satisfies readonly SessionTool[];

const clientToolSearch = {
    name: "tool_search",
    server: { type: "tool_search", execution: "client" },
} as const satisfies SessionTool;

describe("Codex tool search", () => {
    it("ranks tool names, descriptions, and parameter metadata", () => {
        expect(searchCodexTools(tools, "create calendar meeting")).toEqual([tools[0]]);
        expect(searchCodexTools(tools, "IANA timezones")).toEqual([tools[0]]);
        expect(searchCodexTools(tools, "finding", 1)).toEqual([tools[2]]);
        expect(searchCodexTools(tools, "weather forecast")).toEqual([]);
    });

    it("includes caller-supplied BM25 keywords", () => {
        const keywordTool = {
            ...tools[2],
            searchKeywords: ["phonograph", "vinyl"],
        } as const satisfies SessionTool;

        expect(searchCodexTools([keywordTool], "phonograph")).toEqual([keywordTool]);
    });

    it("settles client discovery with native output and removes it from executor work", () => {
        const settled = settleCodexToolSearch(
            {
                assistantText: "",
                outputItems: [
                    JSON.stringify({
                        type: "tool_search_call",
                        call_id: "search-1",
                        execution: "client",
                        arguments: { query: "calendar meeting" },
                    }),
                ],
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            callId: "search-1",
                            name: "tool_search",
                            arguments: '{"query":"calendar meeting"}',
                            vendor: { provider: "codex", type: "tool_search_call" },
                        },
                    ],
                },
                toolCalls: [
                    {
                        callId: "search-1",
                        name: "tool_search",
                        arguments: '{"query":"calendar meeting"}',
                        vendor: { provider: "codex", type: "tool_search_call" },
                    },
                ],
            },
            [...tools, clientToolSearch],
        );

        expect(settled.settled).toBe(true);
        expect(settled.settlements).toEqual([
            expect.objectContaining({
                call: expect.objectContaining({ callId: "search-1" }),
                outputItem: expect.any(String),
            }),
        ]);
        expect(settled.result.toolCalls).toEqual([]);
        expect(settled.result.message.content).toContainEqual(
            expect.objectContaining({
                type: "tool_call",
                callId: "search-1",
                server: true,
            }),
        );
        expect(JSON.parse(settled.result.outputItems.at(-1)!)).toMatchObject({
            type: "tool_search_output",
            call_id: "search-1",
            execution: "client",
            status: "completed",
            tools: [
                {
                    type: "function",
                    name: "calendar_create_event",
                    defer_loading: true,
                },
            ],
        });
    });

    it("keeps an ordinary call while settling a parallel discovery call", () => {
        const settled = settleCodexToolSearch(
            {
                assistantText: "",
                outputItems: [],
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            callId: "search-1",
                            name: "tool_search",
                            arguments: '{"query":"repository source"}',
                            vendor: { provider: "codex", type: "tool_search_call" },
                        },
                        {
                            type: "tool_call",
                            callId: "shell-1",
                            name: "exec_command",
                            arguments: '{"cmd":"pwd"}',
                            vendor: { provider: "codex", type: "function_call" },
                        },
                    ],
                },
                toolCalls: [
                    {
                        callId: "search-1",
                        name: "tool_search",
                        arguments: '{"query":"repository source"}',
                        vendor: { provider: "codex", type: "tool_search_call" },
                    },
                    {
                        callId: "shell-1",
                        name: "exec_command",
                        arguments: '{"cmd":"pwd"}',
                        vendor: { provider: "codex", type: "function_call" },
                    },
                ],
            },
            [...tools, clientToolSearch],
        );

        expect(settled.result.toolCalls).toEqual([
            expect.objectContaining({ callId: "shell-1", name: "exec_command" }),
        ]);
        expect(
            settled.result.outputItems.filter(
                (item) => JSON.parse(item).type === "tool_search_output",
            ),
        ).toHaveLength(1);
    });

    it("does not settle a search call unless the caller supplied client discovery", () => {
        const input = {
            assistantText: "",
            outputItems: [],
            message: {
                role: "assistant" as const,
                content: [
                    {
                        type: "tool_call" as const,
                        callId: "search-1",
                        name: "tool_search",
                        arguments: '{"query":"calendar"}',
                        vendor: { provider: "codex", type: "tool_search_call" },
                    },
                ],
            },
            toolCalls: [
                {
                    callId: "search-1",
                    name: "tool_search",
                    arguments: '{"query":"calendar"}',
                    vendor: { provider: "codex", type: "tool_search_call" },
                },
            ],
        };

        expect(settleCodexToolSearch(input, tools)).toEqual({
            result: input,
            settled: false,
            settlements: [],
        });
    });
});
