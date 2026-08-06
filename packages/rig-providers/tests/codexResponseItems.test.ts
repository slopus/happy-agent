import { describe, expect, it } from "vitest";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { getCodexIncrementalInput } from "@/vendors/codex/impl/getCodexIncrementalInput.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { tool_search } from "@/vendors/codex/tools/tool_search.js";
import { withCodexStreamIdleTimeout } from "@/vendors/codex/impl/codexRetry.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";

describe("Codex response items", () => {
    it("deterministically hashes overlong call IDs across opaque calls and their results", () => {
        const overlongCallId = `call_${"x".repeat(78)}`;
        const context: SessionContext = {
            instructions: "instructions",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    responseItems: [
                        JSON.stringify({
                            arguments: "{}",
                            call_id: overlongCallId,
                            name: "inspect",
                            type: "function_call",
                        }),
                    ],
                    toolCalls: [
                        {
                            arguments: "{}",
                            callId: overlongCallId,
                            name: "inspect",
                        },
                    ],
                },
                {
                    role: "tool",
                    callId: overlongCallId,
                    content: "done",
                },
            ],
        };

        const first = toOpenAIResponseInput(context);
        const second = toOpenAIResponseInput(context);
        const callId = (first[0] as { call_id: string }).call_id;

        expect(first).toEqual(second);
        expect(callId).not.toBe(overlongCallId);
        expect(callId).toHaveLength(64);
        expect((first[1] as { call_id: string }).call_id).toBe(callId);
    });

    it("preserves function namespaces through streaming and replay", async () => {
        const functionCall = {
            type: "function_call",
            call_id: "spawn-call",
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: '{"task_name":"inspect","message":"Inspect it."}',
        };
        const mapped = mapOpenAIResponseStream(
            (async function* () {
                yield {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: functionCall,
                } as never;
                yield {
                    type: "response.completed",
                    response: {
                        id: "response",
                        output: [functionCall],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                } as never;
            })(),
            { failureMessage: "failed", requireTerminalEvent: true, vendor: "codex" },
        );
        const events = [];
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
            callId: "spawn-call",
            name: "spawn_agent",
            namespace: "collaboration",
            vendor: { provider: "codex", type: "function_call" },
        });
        expect(result).toMatchObject({
            toolCalls: [
                {
                    callId: "spawn-call",
                    name: "spawn_agent",
                    namespace: "collaboration",
                },
            ],
        });
        if (result === undefined || !("toolCalls" in result)) expect.fail("Missing mapped result.");
        expect(
            toOpenAIResponseInput({
                instructions: "instructions",
                messages: [{ role: "assistant", content: "", toolCalls: result.toolCalls }],
            }),
        ).toEqual([functionCall]);
    });

    it("uses caller namespace descriptions and never emits an empty fallback", () => {
        const tool = {
            name: "spawn_agent",
            namespace: "rig",
            namespaceDescription: "Provider-neutral collaboration tools.",
            type: "local",
            description: "Spawn an agent.",
        } as const satisfies SessionTool;

        expect(toCodexToolDefinitions([tool])).toEqual([
            {
                type: "namespace",
                name: "rig",
                description: "Provider-neutral collaboration tools.",
                tools: [
                    {
                        type: "function",
                        name: "spawn_agent",
                        description: "Spawn an agent.",
                        parameters: null,
                        strict: false,
                    },
                ],
            },
        ]);
        expect(
            toCodexToolDefinitions([
                {
                    name: tool.name,
                    namespace: "custom",
                    type: tool.type,
                    description: tool.description,
                },
            ]),
        ).toMatchObject([{ description: "Tools in the custom namespace." }]);
    });

    it("keeps native and cross-provider spawn in distinct namespaces", () => {
        const tools: readonly SessionTool[] = [
            {
                name: "spawn_agent",
                namespace: "collaboration",
                namespaceDescription: "Tools for spawning and managing sub-agents.",
                type: "local",
                description: "Spawn a native Codex subagent.",
            },
            {
                name: "spawn_agent",
                namespace: "collaboration_ext",
                namespaceDescription:
                    "Tools for spawning sub-agents across providers and model families.",
                type: "local",
                description: "Spawn a subagent with an explicit provider and model.",
            },
        ];

        expect(toCodexToolDefinitions(tools)).toMatchObject([
            {
                type: "namespace",
                name: "collaboration",
                tools: [{ name: "spawn_agent" }],
            },
            {
                type: "namespace",
                name: "collaboration_ext",
                tools: [{ name: "spawn_agent" }],
            },
        ]);
    });

    it("requires response item IDs to match before reusing previous_response_id", () => {
        const previousRequest = {
            model: "gpt-5.6-sol",
            input: [{ type: "message", role: "user", content: "first" }],
        };
        const responseItems = [
            {
                id: "server-message-id",
                type: "message",
                role: "assistant",
                content: [],
            },
        ];
        const rebuilt = {
            model: "gpt-5.6-sol",
            input: [
                ...previousRequest.input,
                { ...responseItems[0], id: "different-message-id" },
                { type: "message", role: "user", content: "second" },
            ],
        };

        expect(getCodexIncrementalInput(previousRequest, responseItems, rebuilt)).toBeUndefined();
    });

    it("selects the native tool-search definition from vendor metadata, not its name", () => {
        const ordinaryToolSearch: SessionTool = {
            ...tool_search,
            vendor: undefined,
        };

        expect(toCodexToolDefinitions([tool_search])).toEqual([
            {
                type: "tool_search",
                execution: "client",
                description: tool_search.description,
                parameters: {
                    type: "object",
                    properties: {
                        limit: {
                            type: "number",
                            description: "Maximum number of tools to return. Defaults to 8.",
                        },
                        query: {
                            type: "string",
                            description: "Search query for deferred tools.",
                        },
                    },
                    required: ["query"],
                    additionalProperties: false,
                },
            },
        ]);
        expect(toCodexToolDefinitions([ordinaryToolSearch])).toMatchObject([
            {
                type: "function",
                name: "tool_search",
            },
        ]);
        expect(
            toOpenAIResponseInput({
                instructions: "instructions",
                messages: [
                    {
                        role: "assistant",
                        content: "",
                        toolCalls: [
                            {
                                callId: "ordinary-search",
                                name: "tool_search",
                                arguments: '{"query":"tools"}',
                                vendor: {
                                    provider: "codex",
                                    type: "function_call",
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        callId: "ordinary-search",
                        content: "[]",
                        vendor: {
                            provider: "codex",
                            type: "function_call",
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                type: "function_call",
                call_id: "ordinary-search",
                name: "tool_search",
                arguments: '{"query":"tools"}',
            },
            {
                type: "function_call_output",
                call_id: "ordinary-search",
                output: "[]",
            },
        ]);
    });

    it("preserves ordered reasoning, commentary, normal tool search, and final text", async () => {
        const reasoning = {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque",
            summary: [],
        };
        const commentary = {
            id: "message-1",
            type: "message",
            role: "assistant",
            phase: "commentary",
            status: "completed",
            content: [{ type: "output_text", text: "Checking. ", annotations: [] }],
        };
        const toolSearch = {
            id: "search-item",
            type: "tool_search_call",
            call_id: "search-call",
            execution: "client",
            status: "completed",
            arguments: { namespace: "github", query: "pull requests" },
        };
        const final = {
            id: "message-2",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
        };
        const output = [reasoning, commentary, toolSearch, final];
        const mapped = mapOpenAIResponseStream(
            (async function* () {
                for (const [output_index, item] of output.entries()) {
                    yield { type: "response.output_item.done", output_index, item } as never;
                }
                yield {
                    type: "response.completed",
                    response: {
                        id: "response",
                        output,
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                } as never;
            })(),
            { failureMessage: "failed", requireTerminalEvent: true, vendor: "codex" },
        );
        const events = [];
        let result: Awaited<ReturnType<typeof mapped.next>>["value"];
        for (;;) {
            const next = await mapped.next();
            if (next.done) {
                result = next.value;
                break;
            }
            events.push(next.value);
        }

        expect(result).toMatchObject({
            assistantText: "Checking. Done.",
            toolCalls: [
                {
                    callId: "search-call",
                    name: "tool_search",
                    vendor: {
                        provider: "codex",
                        type: "tool_search_call",
                        execution: "client",
                    },
                    arguments: '{"namespace":"github","query":"pull requests"}',
                },
            ],
        });
        if (result === undefined || !("responseItems" in result))
            expect.fail("Missing mapped result.");
        expect(result.responseItems.map((item) => JSON.parse(item))).toEqual(output);
        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "search-call",
            name: "tool_search",
            vendor: {
                provider: "codex",
                type: "tool_search_call",
                execution: "client",
            },
        });

        const context: SessionContext = {
            instructions: "instructions",
            messages: [
                {
                    role: "assistant",
                    content: result.assistantText,
                    toolCalls: result.toolCalls,
                    responseItems: result.responseItems,
                },
                {
                    role: "tool",
                    callId: "search-call",
                    vendor: {
                        provider: "codex",
                        type: "tool_search_call",
                        execution: "client",
                    },
                    content: JSON.stringify([{ type: "function", name: "github_search" }]),
                },
            ],
        };
        expect(toOpenAIResponseInput(context)).toEqual([
            ...output,
            {
                type: "tool_search_output",
                call_id: "search-call",
                execution: "client",
                status: "completed",
                tools: [{ type: "function", name: "github_search" }],
            },
        ]);
    });

    it("rebuilds tool search from the normal tool-call fields when opaque items are absent", () => {
        expect(
            toOpenAIResponseInput({
                instructions: "instructions",
                messages: [
                    {
                        role: "assistant",
                        content: "",
                        toolCalls: [
                            {
                                callId: "search-call",
                                name: "tool_search",
                                vendor: {
                                    provider: "codex",
                                    type: "tool_search_call",
                                    execution: "client",
                                },
                                arguments: '{"query":"tools"}',
                            },
                        ],
                    },
                    {
                        role: "tool",
                        callId: "search-call",
                        vendor: {
                            provider: "codex",
                            type: "tool_search_call",
                            execution: "client",
                        },
                        content: "[]",
                    },
                ],
            }),
        ).toEqual([
            {
                type: "tool_search_call",
                call_id: "search-call",
                execution: "client",
                arguments: { query: "tools" },
            },
            {
                type: "tool_search_output",
                call_id: "search-call",
                execution: "client",
                status: "completed",
                tools: [],
            },
        ]);
    });

    it("does not interpret another provider's native tool metadata", () => {
        const codexContext: SessionContext = {
            instructions: "instructions",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [
                        {
                            callId: "grok-call",
                            name: "search",
                            arguments: "{}",
                            vendor: {
                                provider: "grok",
                                type: "custom_tool_call",
                            },
                        },
                    ],
                },
                {
                    role: "tool",
                    callId: "grok-call",
                    content: "result",
                    vendor: {
                        provider: "grok",
                        type: "custom_tool_call",
                    },
                },
            ],
        };
        expect(toOpenAIResponseInput(codexContext)).toEqual([
            {
                type: "function_call",
                call_id: "grok-call",
                name: "search",
                arguments: "{}",
            },
            {
                type: "function_call_output",
                call_id: "grok-call",
                output: "result",
            },
        ]);

        expect(
            toGrokResponseInput({
                instructions: "instructions",
                messages: [
                    {
                        role: "assistant",
                        content: "",
                        toolCalls: [
                            {
                                callId: "codex-call",
                                name: "exec",
                                arguments: "{}",
                                vendor: {
                                    provider: "codex",
                                    type: "custom_tool_call",
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        callId: "codex-call",
                        content: "result",
                        vendor: {
                            provider: "codex",
                            type: "custom_tool_call",
                        },
                    },
                ],
            }),
        ).toEqual([
            {
                type: "message",
                role: "system",
                content: "instructions",
            },
            {
                type: "function_call",
                call_id: "codex-call",
                name: "exec",
                arguments: "{}",
            },
            {
                type: "function_call_output",
                call_id: "codex-call",
                output: "result",
            },
        ]);
    });

    it("fails a stream that remains idle", async () => {
        const stream = withCodexStreamIdleTimeout({
            stream: {
                [Symbol.asyncIterator]: () => ({
                    next: () => new Promise<IteratorResult<never>>(() => {}),
                }),
            },
            timeoutMs: 5,
        });
        await expect(stream.next()).rejects.toMatchObject({ name: "TimeoutError" });
    });
});
