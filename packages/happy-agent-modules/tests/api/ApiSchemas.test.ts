import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { messageSendBodySchema } from "../../sources/api/ApiSchemas.js";

const message = {
    mode: {
        effort: "medium",
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
        providerId: "codex",
        serviceTier: null,
    },
    text: "Continue.",
} as const;

describe("messageSendBodySchema", () => {
    it("accepts one tool request among ordinary content, with optional exact arguments", () => {
        for (const request of [
            { type: "tool_call_request", name: "list_skills" },
            {
                type: "tool_call_request",
                name: "load_skill",
                arguments: { name: "browser", arguments: "Open a page", nested: [null, true, 3] },
            },
        ]) {
            expect(
                Value.Check(messageSendBodySchema, {
                    ...message,
                    content: [
                        { type: "text", text: "Before" },
                        request,
                        { type: "image", mimeType: "image/png", data: "abc" },
                    ],
                }),
            ).toBe(true);
        }
    });

    it("rejects multiple requests and malformed request arguments", () => {
        const request = { type: "tool_call_request", name: "list_skills" };
        for (const content of [
            [request, request],
            [{ ...request, name: "" }],
            [{ ...request, arguments: null }],
            [{ ...request, arguments: [] }],
            [{ ...request, unexpected: true }],
        ])
            expect(Value.Check(messageSendBodySchema, { ...message, content })).toBe(false);
    });

    it("accepts nullable opaque request profiles up to 512 characters", () => {
        expect(Value.Check(messageSendBodySchema, message)).toBe(true);
        expect(Value.Check(messageSendBodySchema, { ...message, profile: null })).toBe(true);
        expect(Value.Check(messageSendBodySchema, { ...message, profile: "x".repeat(512) })).toBe(
            true,
        );
        expect(Value.Check(messageSendBodySchema, { ...message, profile: "x".repeat(513) })).toBe(
            false,
        );
    });
});
