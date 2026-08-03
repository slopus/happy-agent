import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { Executor } from "@/Executor.js";
import { createExecutorInferenceStream } from "@/createExecutorInferenceStream.js";
import { defineModel } from "@/types.js";

describe("createExecutorInferenceStream", () => {
    it("forwards structured output to the provider run request", async () => {
        let received: unknown;
        const schema = Type.Object({ result: Type.String() });
        const executor = {
            run: async function* (request: unknown) {
                received = request;
                yield { type: "done", state: "normal" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "openai/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "codex",
            streamOptions: {
                structuredOutput: { name: "test_output", schema },
            },
        });

        for await (const _event of stream) {
            // Consume the stream so the executor request is created.
        }

        expect(received).toMatchObject({
            structuredOutput: { name: "test_output", schema },
        });
    });

    it("preserves encrypted collaboration input as a provider agent message", async () => {
        let received: unknown;
        const executor = {
            type: "codex",
            run: async function* (request: unknown) {
                received = request;
                yield { type: "done", state: "normal" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: {
                messages: [
                    {
                        role: "user",
                        content: "",
                        encryptedAgentMessage: {
                            author: "/root",
                            recipient: "/root/child",
                            header: "Message Type: NEW_TASK\nPayload:\n",
                            encryptedContent: "opaque-task",
                        },
                        agentMessageTriggerTurn: true,
                        timestamp: 1,
                    },
                ],
            },
            executor,
            model: defineModel({
                id: "openai/test",
                name: "Test",
                thinkingLevels: ["low"],
                defaultThinkingLevel: "low",
            }),
            providerId: "codex",
        });

        for await (const _event of stream) {
            // Consume the stream so the executor request is created.
        }

        expect(received).toMatchObject({
            context: {
                messages: [
                    {
                        role: "agent",
                        author: "/root",
                        recipient: "/root/child",
                        header: "Message Type: NEW_TASK\nPayload:\n",
                        encryptedContent: "opaque-task",
                        agentMessageTriggerTurn: true,
                    },
                ],
            },
        });
    });

    it("forwards provider retry progress without restarting inference", async () => {
        const executor = {
            run: async function* () {
                yield { type: "block_start" } as const;
                yield {
                    type: "retrying",
                    attempt: 2,
                    reason: "Claude API overloaded (HTTP 529).",
                } as const;
                yield { type: "block_stop" } as const;
                yield { type: "done", state: "normal" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "anthropic/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "claude",
        });
        const events = [];

        for await (const event of stream) events.push(event);

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "block_start",
            "retrying",
            "block_stop",
            "done",
        ]);
        expect(events).toContainEqual({
            type: "retrying",
            attempt: 2,
            reason: "Claude API overloaded (HTTP 529).",
        });
        const result = await stream.result();
        expect(result).toMatchObject({ stopReason: "stop" });
        expect(result.contextTokens).toBeUndefined();
    });

    it("records the latest inference usage as both usage and occupied context", async () => {
        const executor = {
            run: async function* () {
                yield {
                    type: "token_usage",
                    usage: {
                        cacheRead: 70,
                        cacheWrite: 5,
                        input: 10,
                        output: 15,
                        totalTokens: 100,
                    },
                } as const;
                yield { type: "done", state: "normal" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "openai/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "codex",
        });

        for await (const _event of stream) {
            // Consume the stream as the agent loop does.
        }

        await expect(stream.result()).resolves.toMatchObject({
            contextTokens: 100,
            usage: {
                cacheRead: 70,
                cacheWrite: 5,
                input: 10,
                output: 15,
                totalTokens: 100,
            },
        });
    });

    it("streams tentative provider blocks and rolls them back on reset", async () => {
        const executor = {
            run: async function* () {
                yield { type: "block_start" } as const;
                yield { type: "reasoning_delta", delta: "considering" } as const;
                yield { type: "text_delta", delta: "tentative" } as const;
                yield {
                    type: "tool_call_start",
                    callId: "tentative-tool",
                    name: "Bash",
                } as const;
                yield {
                    type: "tool_call_delta",
                    callId: "tentative-tool",
                    delta: '{"command":"echo tentative"}',
                } as const;
                yield {
                    type: "tool_call_end",
                    callId: "tentative-tool",
                    arguments: '{"command":"echo tentative"}',
                } as const;
                yield { type: "block_reset" } as const;
                yield { type: "done", state: "cancelled" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "anthropic/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "claude",
        });
        const events = [];

        for await (const event of stream) events.push(event);

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "block_start",
            "thinking_start",
            "thinking_delta",
            "text_start",
            "text_delta",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "block_reset",
            "error",
        ]);
        expect(events.find((event) => event.type === "text_delta")).toMatchObject({
            delta: "tentative",
        });
        expect(events.find((event) => event.type === "thinking_delta")).toMatchObject({
            delta: "considering",
        });
        expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
            toolCall: {
                id: "tentative-tool",
                name: "Bash",
                arguments: { command: "echo tentative" },
            },
        });
        expect(events.find((event) => event.type === "block_reset")).toMatchObject({
            partial: { content: [] },
        });
        await expect(stream.result()).resolves.toMatchObject({
            content: [],
            stopReason: "aborted",
        });
    });

    it("preserves a classified provider error and its reset time", async () => {
        const executor = {
            run: async function* () {
                yield {
                    type: "done",
                    state: "error",
                    kind: "billing_error",
                    message: "Claude usage is exhausted.",
                    providerError: { type: "out_of_tokens", resetAt: 2_000_000 },
                } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "anthropic/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "claude",
        });

        for await (const _event of stream) {
            // Consume the stream as the agent loop does.
        }

        await expect(stream.result()).resolves.toMatchObject({
            errorMessage: "Claude usage is exhausted.",
            providerError: { type: "out_of_tokens", resetAt: 2_000_000 },
            stopReason: "error",
        });
    });

    it("preserves a tool-call namespace from the native provider", async () => {
        const executor = {
            run: async function* () {
                yield {
                    type: "tool_call_start",
                    callId: "spawn-call",
                    name: "spawn_agent",
                    namespace: "collaboration",
                } as const;
                yield {
                    type: "tool_call_end",
                    callId: "spawn-call",
                    arguments: '{"task_name":"inspect","message":"Inspect it."}',
                } as const;
                yield { type: "done", state: "tool_call" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "openai/test",
                name: "Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "codex",
        });

        for await (const _event of stream) {
            // Consume the stream as the agent loop does.
        }

        await expect(stream.result()).resolves.toMatchObject({
            content: [
                {
                    type: "toolCall",
                    id: "spawn-call",
                    name: "spawn_agent",
                    namespace: "collaboration",
                },
            ],
            stopReason: "toolUse",
        });
    });

    it("reports a provider-run search without turning it into a tool call to execute", async () => {
        const executor = {
            run: async function* () {
                yield { type: "server_tool_call_start", callId: "x-1", name: "x_keyword_search" };
                yield { type: "server_tool_call_delta", callId: "x-1", delta: '{"query":"Cla' };
                yield {
                    type: "server_tool_call_delta",
                    callId: "x-1",
                    delta: 'ude Code","limit":"5"}',
                };
                yield {
                    type: "server_tool_call_end",
                    callId: "x-1",
                    name: "x_keyword_search",
                    arguments: '{"query":"Claude Code","limit":"5"}',
                };
                yield { type: "text_delta", delta: "People are talking about it." };
                yield { type: "done", state: "normal" } as const;
            },
        } as unknown as Executor;
        const stream = createExecutorInferenceStream({
            context: { messages: [] },
            executor,
            model: defineModel({
                id: "xai/grok-test",
                name: "Grok Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
            providerId: "grok",
        });

        const events = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.filter((event) => event.type.startsWith("server_toolcall_"))).toEqual([
            { type: "server_toolcall_start", callId: "x-1", name: "x_keyword_search" },
            { type: "server_toolcall_delta", callId: "x-1", delta: '{"query":"Cla' },
            { type: "server_toolcall_delta", callId: "x-1", delta: 'ude Code","limit":"5"}' },
            {
                type: "server_toolcall_end",
                callId: "x-1",
                name: "x_keyword_search",
                arguments: '{"query":"Claude Code","limit":"5"}',
            },
        ]);
        expect(events.some((event) => event.type.startsWith("toolcall_"))).toBe(false);

        const message = await stream.result();
        expect(message.content).toEqual([{ type: "text", text: "People are talking about it." }]);
        expect(message.stopReason).toBe("stop");
    });
});
