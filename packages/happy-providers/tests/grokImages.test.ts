import { describe, expect, it } from "vitest";

import { isGrokImageStripError } from "@/vendors/grok/errors/grokErrors.js";
import { stripGrokContextImages } from "@/vendors/grok/impl/stripGrokContextImages.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";

describe("Grok image input", () => {
    it("serializes user and tool-result images as Responses API data URLs", () => {
        const input = toGrokResponseInput({
            instructions: "System.",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "user image" },
                        { type: "image", mimeType: "image/png", data: "dXNlcg==" },
                    ],
                },
                {
                    role: "assistant",
                    content: [
                        ...[
                            {
                                callId: "call-1",
                                name: "read_file",
                                arguments: "{}",
                                vendor: { provider: "grok", type: "function_call" },
                            },
                        ].map((call) => ({
                            type: "tool_call" as const,
                            ...call,
                        })),
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "text", text: "tool image" },
                        { type: "image", mimeType: "image/webp", data: "dG9vbA==" },
                    ],
                    callId: "call-1",
                },
            ],
        });

        expect(input).toContainEqual({
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "user image" },
                {
                    type: "input_image",
                    detail: "auto",
                    image_url: "data:image/png;base64,dXNlcg==",
                },
            ],
        });
        expect(input).toContainEqual({
            type: "function_call_output",
            call_id: "call-1",
            output: [
                { type: "input_text", text: "tool image" },
                {
                    type: "input_image",
                    detail: "auto",
                    image_url: "data:image/webp;base64,dG9vbA==",
                },
            ],
        });
    });

    it("matches native image recovery and preserves ordered text context", () => {
        const context = {
            instructions: "System.",
            messages: [
                {
                    role: "user" as const,
                    content: [
                        { type: "text" as const, text: "before" },
                        {
                            type: "image" as const,
                            mimeType: "image/png",
                            data: "aW1hZ2U=",
                        },
                        { type: "text" as const, text: "after" },
                    ],
                },
            ],
        };

        expect(isGrokImageStripError({ status: 413 })).toBe(true);
        expect(
            isGrokImageStripError({
                status: 500,
                message: "Could not process image",
            }),
        ).toBe(true);
        expect(stripGrokContextImages(context)).toEqual({
            instructions: "System.",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "before" },
                        { type: "text", text: "after" },
                    ],
                },
            ],
        });
    });
});
