import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
    sessionInputToolSchema,
    type SessionInputTool,
    type SessionInputBlock,
    type SessionMessage,
    type SessionUserMessage,
} from "@/index.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";

describe("SessionInputTool", () => {
    it("is a normal user message carrying an optional-arguments tool request", () => {
        const request: SessionInputTool = {
            type: "tool_call_request",
            name: "refresh_status",
        };
        const message: SessionUserMessage = {
            role: "user",
            content: [{ type: "text", text: "/refresh-status" }, request],
        };
        const user: SessionUserMessage = message;

        expect(user.content[1]).toEqual(request);
        expect(Value.Check(sessionInputToolSchema, request)).toBe(true);
        expect(
            Value.Check(sessionInputToolSchema, {
                type: "tool_call_request",
                name: "load_skill",
                arguments: {
                    name: "agent-browser",
                    arguments: "Open example.com",
                    nested: { enabled: true, values: [1, null] },
                },
            }),
        ).toBe(true);
    });

    it.each([0, 1, 2])("accepts a tool request at content position %s", (position) => {
        const content: SessionInputBlock[] = [
            { type: "text", text: "Before" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ];
        const request: SessionInputTool = { type: "tool_call_request", name: "refresh_status" };
        content.splice(position, 0, request);
        const message: SessionUserMessage = { role: "user", content };
        const history: SessionMessage[] = [message];

        expectTypeOf<SessionUserMessage>().toExtend<SessionMessage>();
        expect(history[0]).toBe(message);
        expect(message.content[position]).toBe(request);
    });

    it.each([
        [
            "Responses",
            (message: SessionUserMessage) =>
                toOpenAIResponseInput({ instructions: "", messages: [message] }),
        ],
        ["Anthropic", (message: SessionUserMessage) => toAnthropicMessages([message])],
        [
            "Grok",
            (message: SessionUserMessage) =>
                toGrokResponseInput({ instructions: "", messages: [message] }),
        ],
        [
            "Claude",
            (message: SessionUserMessage) =>
                createClaudeSessionReplay({
                    context: { instructions: "", messages: [message] },
                    model: "test",
                    sessionId: "test",
                }),
        ],
    ] as const)("%s rejects a request the agent loop has not consumed", (_name, serialize) => {
        const message: SessionUserMessage = {
            role: "user",
            content: [
                { type: "tool_call_request", name: "refresh_status" },
                { type: "text", text: "Explain the result" },
            ],
        };
        const before = structuredClone(message);
        expect(() => serialize(message)).toThrow(
            "Tool requests must be executed by the agent before inference.",
        );
        expect(message).toEqual(before);
    });

    it("rejects malformed tool requests", () => {
        expect(
            Value.Check(sessionInputToolSchema, {
                type: "tool_call_request",
                name: "",
            }),
        ).toBe(false);
        expect(
            Value.Check(sessionInputToolSchema, {
                type: "tool_call_request",
                name: "refresh_status",
                arguments: [],
            }),
        ).toBe(false);
        expect(
            Value.Check(sessionInputToolSchema, {
                type: "tool_call_request",
                name: "refresh_status",
                unexpected: true,
            }),
        ).toBe(false);
    });
});
