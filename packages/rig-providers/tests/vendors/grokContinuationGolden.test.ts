import { describe, expect, it } from "vitest";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import { createGrokOpenAIRequest } from "@/vendors/grok/impl/createGrokOpenAIRequest.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";
import { grok_compaction_prompt } from "@/vendors/grok/prompts/grok_compaction_prompt.js";

describe("Grok continuation goldens", () => {
    it("preserves reasoning, tool calls, tool outputs, and following assistant text", () => {
        const reasoning = {
            type: "reasoning",
            id: "reasoning-1",
            summary: [{ type: "summary_text", text: "Inspect the directory." }],
            encrypted_content: "<ENCRYPTED_REASONING>",
        };
        expect(
            toGrokResponseInput({
                instructions: "System prompt.",
                messages: [
                    { role: "user", content: "Inspect the workspace." },
                    {
                        role: "assistant",
                        content: "",
                        encryptedReasoning: JSON.stringify(reasoning),
                        toolCalls: [
                            {
                                callId: "call-1",
                                name: "list_dir",
                                arguments: '{"target_directory":"."}',
                                vendor: { provider: "grok", type: "function_call" },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        callId: "call-1",
                        content: "README.md",
                        vendor: { provider: "grok", type: "function_call" },
                    },
                    { role: "assistant", content: "The workspace contains README.md." },
                    { role: "user", content: "Continue." },
                ],
            }),
        ).toEqual([
            { type: "message", role: "system", content: "System prompt." },
            { type: "message", role: "user", content: "Inspect the workspace." },
            reasoning,
            {
                type: "function_call",
                call_id: "call-1",
                name: "list_dir",
                arguments: '{"target_directory":"."}',
            },
            { type: "function_call_output", call_id: "call-1", output: "README.md" },
            {
                type: "message",
                role: "assistant",
                content: "The workspace contains README.md.",
            },
            { type: "message", role: "user", content: "Continue." },
        ]);
    });

    it.each(["low", "medium", "high"] satisfies SessionReasoningEffort[])(
        "sends captured Grok 4.5 %s reasoning configuration",
        (effort) => {
            const request = createGrokOpenAIRequest({
                apiModelId: "grok-4.5",
                context: { instructions: "System prompt.", messages: [] },
                effort,
                tools: [],
            });
            expect(request.reasoning).toEqual({ effort, summary: "concise" });
            expect(request.temperature).toBeUndefined();
            expect(request.top_p).toBeUndefined();
        },
    );

    it("omits unsupported reasoning effort for Composer 2.5", () => {
        const request = createGrokOpenAIRequest({
            apiModelId: "grok-composer-2.5-fast",
            context: { instructions: "System prompt.", messages: [] },
            effort: "off",
            tools: [],
        });

        expect(request.reasoning).toEqual({ summary: "concise" });
    });

    it("maps reasoning, tool calls, encrypted continuation, usage, and completion", async () => {
        const events = await collect(
            mapOpenAIResponseStream(
                stream([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            type: "reasoning",
                            id: "reasoning-1",
                            summary: [],
                            encrypted_content: null,
                        },
                    },
                    {
                        type: "response.reasoning_summary_text.delta",
                        output_index: 0,
                        delta: "Inspecting.",
                    },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "reasoning",
                            id: "reasoning-1",
                            summary: [{ type: "summary_text", text: "Inspecting." }],
                            encrypted_content: "<ENCRYPTED_REASONING>",
                        },
                    },
                    {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: {
                            type: "function_call",
                            id: "function-1",
                            call_id: "call-1",
                            name: "list_dir",
                            arguments: "",
                            status: "in_progress",
                        },
                    },
                    {
                        type: "response.function_call_arguments.delta",
                        output_index: 1,
                        item_id: "function-1",
                        delta: '{"target_directory":"."}',
                    },
                    {
                        type: "response.completed",
                        response: {
                            id: "response-1",
                            output: [],
                            usage: {
                                input_tokens: 12,
                                output_tokens: 4,
                                total_tokens: 16,
                                input_tokens_details: { cached_tokens: 3 },
                            },
                        },
                    },
                ]),
                { failureMessage: "Grok failed." },
            ),
        );
        expect(events).toEqual([
            { type: "reasoning_delta", delta: "Inspecting." },
            {
                type: "encrypted_reasoning",
                content: JSON.stringify({
                    type: "reasoning",
                    id: "reasoning-1",
                    summary: [{ type: "summary_text", text: "Inspecting." }],
                    encrypted_content: "<ENCRYPTED_REASONING>",
                }),
            },
            {
                type: "toolcall_start",
                callId: "call-1",
                name: "list_dir",
                vendor: { provider: "grok", type: "function_call" },
            },
            {
                type: "toolcall_delta",
                callId: "call-1",
                delta: '{"target_directory":"."}',
            },
            {
                type: "toolcall_end",
                callId: "call-1",
                arguments: '{"target_directory":"."}',
            },
            {
                type: "token_usage",
                usage: { input: 9, output: 4, cacheRead: 3, cacheWrite: 0, totalTokens: 16 },
            },
            { type: "done", state: "tool_call" },
        ]);
    });

    it("uses the Grok 4.5 source compaction contract", () => {
        expect(grok_compaction_prompt).toContain(
            "produce a faithful, concise summary of the conversation so far",
        );
        expect(grok_compaction_prompt).toContain("1. Primary Request and Intent");
        expect(grok_compaction_prompt).toContain("9. Optional Next Step");
        expect(grok_compaction_prompt).toContain("Respond with ONLY the <summary>");
    });

    it("maps max-output truncation without reporting a normal completion", async () => {
        const events = await collect(
            mapOpenAIResponseStream(
                stream([
                    {
                        type: "response.incomplete",
                        response: {
                            incomplete_details: { reason: "max_output_tokens" },
                            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
                        },
                    },
                ]),
                { failureMessage: "Grok failed." },
            ),
        );
        expect(events).toEqual([
            {
                type: "token_usage",
                usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
            },
            { type: "done", state: "length" },
        ]);
    });

    it("closes a custom tool item that is still active at max-output truncation", async () => {
        const events = await collect(
            mapOpenAIResponseStream(
                stream([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            type: "custom_tool_call",
                            id: "custom-1",
                            call_id: "call-partial",
                            name: "apply_patch",
                            input: "",
                            status: "in_progress",
                        },
                    },
                    {
                        type: "response.custom_tool_call_input.delta",
                        output_index: 0,
                        delta: "*** Begin Patch",
                    },
                    {
                        type: "response.incomplete",
                        response: {
                            incomplete_details: { reason: "max_output_tokens" },
                            output: [
                                {
                                    type: "custom_tool_call",
                                    id: "custom-1",
                                    call_id: "call-partial",
                                    name: "apply_patch",
                                    input: "*** Begin Patch",
                                    status: "incomplete",
                                },
                            ],
                            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
                        },
                    },
                ]),
                { failureMessage: "Grok failed." },
            ),
        );

        expect(events).toEqual([
            {
                type: "toolcall_start",
                callId: "call-partial",
                name: "apply_patch",
                vendor: { provider: "grok", type: "custom_tool_call" },
            },
            {
                type: "toolcall_delta",
                callId: "call-partial",
                delta: "*** Begin Patch",
            },
            {
                type: "toolcall_end",
                callId: "call-partial",
                arguments: "*** Begin Patch",
                incomplete: true,
            },
            {
                type: "token_usage",
                usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
            },
            { type: "done", state: "length" },
        ]);
    });

    it("marks an incomplete function item as non-executable before max-output termination", async () => {
        const item = {
            type: "function_call" as const,
            id: "function-1",
            call_id: "call-function-partial",
            name: "exec_command",
            arguments: '{"cmd":"printf',
            status: "incomplete" as const,
        };
        const events = await collect(
            mapOpenAIResponseStream(
                stream([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item,
                    },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item,
                    },
                    {
                        type: "response.incomplete",
                        response: {
                            incomplete_details: { reason: "max_output_tokens" },
                            output: [item],
                            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
                        },
                    },
                ]),
                { failureMessage: "Grok failed." },
            ),
        );

        expect(events).toContainEqual({
            type: "toolcall_end",
            callId: "call-function-partial",
            arguments: '{"cmd":"printf',
            incomplete: true,
        });
        expect(events.at(-1)).toEqual({ type: "done", state: "length" });
    });

    it("surfaces typed stream failures", async () => {
        await expect(
            collect(
                mapOpenAIResponseStream(
                    stream([
                        {
                            type: "response.failed",
                            response: {
                                error: { code: "server_error", message: "backend unavailable" },
                            },
                        },
                    ]),
                    { failureMessage: "Grok failed." },
                ),
            ),
        ).rejects.toMatchObject({ code: "server_error", message: "backend unavailable" });
    });

    it("rejects a stream that closes without a terminal response event", async () => {
        await expect(
            collect(
                mapOpenAIResponseStream(
                    stream([
                        {
                            type: "response.output_text.delta",
                            output_index: 0,
                            delta: "partial",
                        },
                    ]),
                    {
                        failureMessage: "Grok failed.",
                        requireTerminalEvent: true,
                    },
                ),
            ),
        ).rejects.toThrow("Response stream closed before completion.");
    });
});

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
    const values: unknown[] = [];
    for await (const value of iterable) values.push(value);
    return values;
}

async function* stream(events: readonly unknown[]): AsyncGenerator<any> {
    for (const event of events) yield event;
}
