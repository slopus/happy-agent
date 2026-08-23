import { describe, expect, it } from "vitest";

import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";

describe("Codex image input", () => {
    it("advertises image input and preserves ordered user and tool-result content", () => {
        expect(CodexProvider.inputTypes).toEqual(["text", "image"]);
        expect(
            toOpenAIResponseInput({
                instructions: "instructions",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "look at this" },
                            { type: "image", mimeType: "image/png", data: "dXNlcg==" },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            ...[
                                {
                                    callId: "image-call",
                                    name: "view_image",
                                    arguments: "{}",
                                    vendor: {
                                        provider: "codex",
                                        type: "function_call",
                                        providerCallId: "image-call",
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
                        content: [
                            { type: "text", text: "tool image" },
                            { type: "image", mimeType: "image/webp", data: "dG9vbA==" },
                        ],
                        callId: "image-call",
                        vendor: { provider: "codex", type: "function_call" },
                    },
                ],
            }),
        ).toEqual([
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "look at this" },
                    {
                        type: "input_image",
                        detail: "auto",
                        image_url: "data:image/png;base64,dXNlcg==",
                    },
                ],
            },
            {
                type: "function_call",
                call_id: "image-call",
                name: "view_image",
                arguments: "{}",
            },
            {
                type: "function_call_output",
                call_id: "image-call",
                output: [
                    { type: "input_text", text: "tool image" },
                    {
                        type: "input_image",
                        detail: "auto",
                        image_url: "data:image/webp;base64,dG9vbA==",
                    },
                ],
            },
        ]);
    });
});
