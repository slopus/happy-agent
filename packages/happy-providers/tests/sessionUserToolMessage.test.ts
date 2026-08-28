import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    sessionInputToolSchema,
    type SessionInputTool,
    type SessionUserMessage,
    type SessionUserToolMessage,
} from "@/index.js";

describe("SessionUserToolMessage", () => {
    it("is a normal user message carrying an optional-arguments tool request", () => {
        const request: SessionInputTool = {
            type: "tool_call_request",
            name: "refresh_status",
        };
        const message: SessionUserToolMessage = {
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
