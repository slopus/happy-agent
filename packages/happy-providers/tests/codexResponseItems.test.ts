import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

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
    it("does not send unsupported Unicode regex patterns in tool schemas", () => {
        const definitions = toCodexToolDefinitions([
            {
                name: "get_project",
                parameters: Type.Object(
                    {
                        projectId: Type.String({
                            minLength: 1,
                            maxLength: 96,
                            pattern:
                                "^(?=[\\s\\S]*[^\\p{Cc}\\p{Cf}\\p{Cn}\\p{Cs}\\p{Zs}\\p{Zl}\\p{Zp}\\p{Mn}\\p{Me}])(?:[^\\uD800-\\uDFFF])+$",
                        }),
                    },
                    { additionalProperties: false },
                ),
            },
        ]);

        expect(JSON.stringify(definitions)).not.toContain("pattern");
        expect(definitions).toMatchObject([
            {
                parameters: {
                    properties: {
                        projectId: {
                            description: expect.stringContaining("visible characters"),
                        },
                    },
                },
            },
        ]);
    });

    it("deterministically hashes overlong call IDs across opaque calls and their results", () => {
        const overlongCallId = `call_${"x".repeat(78)}`;
        const context: SessionContext = {
            instructions: "instructions",
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            arguments: "{}",
                            callId: overlongCallId,
                            name: "inspect",
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "done" }],
                    callId: overlongCallId,
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
                messages: [
                    {
                        role: "assistant",
                        content: [
                            ...result.toolCalls.map((call) => ({
                                type: "tool_call" as const,
                                ...call,
                            })),
                        ],
                    },
                ],
            }),
        ).toEqual([functionCall]);
    });

    it("uses caller namespace descriptions and never emits an empty fallback", () => {
        const tool = {
            name: "spawn_agent",
            namespace: "rig",
            namespaceDescription: "Provider-neutral collaboration tools.",
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
                description: "Spawn a native Codex subagent.",
            },
            {
                name: "spawn_agent",
                namespace: "collaboration_ext",
                namespaceDescription:
                    "Tools for spawning sub-agents across providers and model families.",
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

    it("reuses previous_response_id without exposing provider-generated message IDs", () => {
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

        expect(getCodexIncrementalInput(previousRequest, responseItems, rebuilt)).toEqual([
            { type: "message", role: "user", content: "second" },
        ]);
    });

    it("rebuilds context after executor argument normalization", () => {
        const user = { type: "message", role: "user", content: "Read it." };
        const functionCall = {
            type: "function_call",
            call_id: "call-1",
            name: "Read",
            arguments: '{"file_path": "/tmp/input"}',
        };
        const previousRequest = { model: "gpt-5.6-sol", input: [user] };
        const rebuilt = {
            model: "gpt-5.6-sol",
            input: toOpenAIResponseInput({
                instructions: "instructions",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: "Read it." }],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                callId: "call-1",
                                name: "Read",
                                arguments: '{"file_path":"/tmp/input"}',
                            },
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "done" }],
                        callId: "call-1",
                    },
                ],
            }),
        };

        expect(rebuilt.input[1]).toEqual({
            ...functionCall,
            arguments: '{"file_path":"/tmp/input"}',
        });
        expect(getCodexIncrementalInput(previousRequest, [functionCall], rebuilt)).toBeUndefined();
    });

    /**
     * What a search the provider ran costs the turn after it.
     *
     * Codex answers a hosted search inside its own response, as a `web_search_call` output item.
     * That item is part of what the provider expects to receive back: continuation reuses the
     * previous response ID only while the rebuilt input still begins with exactly the items it
     * already produced. Replay the search and the prefix matches, so only the new question is
     * sent and the cache stays warm.
     *
     * The shape here is the captured one from `codexHostedSearch`, so this is the real item rather
     * than an idea of it.
     */
    it("keeps continuation incremental across a search the provider ran itself", () => {
        const previousRequest = {
            model: "gpt-5.6-sol",
            input: [{ type: "message", role: "user", content: "What is the latest Deno release?" }],
        };
        const hostedSearch = {
            action: { query: "Deno current stable version", type: "search" },
            id: "ws_1",
            type: "web_search_call",
        };
        const answer = { content: [], id: "msg_1", role: "assistant", type: "message" };
        const responseItems = [hostedSearch, answer];
        const rebuilt = {
            model: "gpt-5.6-sol",
            input: [
                ...previousRequest.input,
                hostedSearch,
                answer,
                { type: "message", role: "user", content: "Anything else?" },
            ],
        };

        // Only the new question travels; everything before it is matched and reused.
        expect(getCodexIncrementalInput(previousRequest, responseItems, rebuilt)).toEqual([
            { type: "message", role: "user", content: "Anything else?" },
        ]);
    });

    /**
     * The same turn with the search left out of the replayed prefix.
     *
     * This is the regression a move of provider-run searches onto the assistant message could
     * introduce: represent the search as transcript content and stop replaying the provider's own
     * item, and the rebuilt input no longer starts with what the provider produced. Continuation
     * cannot be reused, so the whole conversation is re-sent uncached on every following turn.
     */
    it("loses incremental continuation when the provider's own search is not replayed", () => {
        const previousRequest = {
            model: "gpt-5.6-sol",
            input: [{ type: "message", role: "user", content: "What is the latest Deno release?" }],
        };
        const hostedSearch = {
            action: { query: "Deno current stable version", type: "search" },
            id: "ws_1",
            type: "web_search_call",
        };
        const answer = { content: [], id: "msg_1", role: "assistant", type: "message" };
        const rebuilt = {
            model: "gpt-5.6-sol",
            input: [
                ...previousRequest.input,
                // The search is gone from the prefix; only the answer remains.
                answer,
                { type: "message", role: "user", content: "Anything else?" },
            ],
        };

        expect(
            getCodexIncrementalInput(previousRequest, [hostedSearch, answer], rebuilt),
        ).toBeUndefined();
    });

    it("keeps arbitrary tool_search functions distinct from the internal native descriptor", () => {
        const ordinaryToolSearch: SessionTool = {
            name: tool_search.name,
            description: tool_search.description,
            parameters: tool_search.parameters,
        };

        expect(toCodexToolDefinitions([tool_search])).toMatchObject([
            { type: "tool_search", execution: "client" },
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
                        content: [
                            ...[
                                {
                                    callId: "ordinary-search",
                                    name: "tool_search",
                                    arguments: '{"query":"tools"}',
                                    vendor: {
                                        provider: "codex",
                                        type: "function_call",
                                    },
                                },
                            ].map((call) => ({
                                type: "tool_call" as const,
                                ...call,
                            })),
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "[]" }],
                        callId: "ordinary-search",
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

    it("hides deferred functions behind a concise native tool search", () => {
        const definitions = toCodexToolDefinitions([
            {
                name: "rare_tool",
                description: "Perform a rare operation.",
                parameters: Type.Object({}),
                defer: true,
            },
        ]);

        expect(definitions).toEqual([
            expect.objectContaining({
                type: "tool_search",
                execution: "client",
            }),
        ]);
        expect(definitions).not.toContainEqual(
            expect.objectContaining({ type: "function", name: "rare_tool" }),
        );
        expect(JSON.stringify(definitions)).not.toContain("AllTrails");
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
        if (result === undefined || !("outputItems" in result))
            expect.fail("Missing mapped result.");
        expect(result.outputItems.map((item) => JSON.parse(item))).toEqual(output);
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
                result.message,
                {
                    role: "tool",
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify([{ type: "function", name: "github_search" }]),
                        },
                    ],
                    callId: "search-call",
                    vendor: {
                        provider: "codex",
                        type: "tool_search_call",
                        execution: "client",
                    },
                },
            ],
        };
        expect(toOpenAIResponseInput(context)).toEqual([
            reasoning,
            {
                type: "message",
                id: "msg_rig_0",
                role: "assistant",
                status: "completed",
                content: commentary.content,
            },
            {
                type: "tool_search_call",
                call_id: "search-call",
                execution: "client",
                arguments: { namespace: "github", query: "pull requests" },
            },
            {
                type: "message",
                id: "msg_rig_1",
                role: "assistant",
                status: "completed",
                content: final.content,
            },
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
                        content: [
                            ...[
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
                            ].map((call) => ({
                                type: "tool_call" as const,
                                ...call,
                            })),
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "[]" }],
                        callId: "search-call",
                        vendor: {
                            provider: "codex",
                            type: "tool_search_call",
                            execution: "client",
                        },
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
                    content: [
                        ...[
                            {
                                callId: "grok-call",
                                name: "search",
                                arguments: "{}",
                                vendor: {
                                    provider: "grok",
                                    type: "custom_tool_call",
                                },
                            },
                        ].map((call) => ({
                            type: "tool_call" as const,
                            ...call,
                        })),
                    ],
                },
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "result" }],
                    callId: "grok-call",
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
                        content: [
                            ...[
                                {
                                    callId: "codex-call",
                                    name: "exec",
                                    arguments: "{}",
                                    vendor: {
                                        provider: "codex",
                                        type: "custom_tool_call",
                                    },
                                },
                            ].map((call) => ({
                                type: "tool_call" as const,
                                ...call,
                            })),
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text" as const, text: "result" }],
                        callId: "codex-call",
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
