import { describe, expect, it } from "vitest";

import { SessionAssistantMessageAccumulator, type SessionContext } from "@/index.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import { getCodexIncrementalInput } from "@/vendors/codex/impl/getCodexIncrementalInput.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";

const INTERNAL_CALL_ID = "tz4a98xxat96iws9zmbrgj3b";
const PROVIDER_CALL_ID = "provider-native-call-7";

function context(): SessionContext {
    return {
        instructions: "Use tools.",
        messages: [
            { role: "user", content: [{ type: "text", text: "Inspect it." }] },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: INTERNAL_CALL_ID,
                        name: "inspect",
                        arguments: "{}",
                        vendor: {
                            provider: "grok",
                            type: "function_call",
                            outputItem: JSON.stringify({
                                type: "function_call",
                                call_id: PROVIDER_CALL_ID,
                                name: "inspect",
                                arguments: "{}",
                            }),
                        },
                    },
                ],
            },
            {
                role: "tool",
                callId: INTERNAL_CALL_ID,
                content: [{ type: "text", text: "done" }],
            },
        ],
    };
}

describe("provider tool-call identity", () => {
    it("replays the context ID even when opaque native state contains another ID", () => {
        const codex = toOpenAIResponseInput(context());
        const grok = toGrokResponseInput(context());
        const anthropic = toAnthropicMessages(context().messages);
        const claude = createClaudeSessionReplay({
            context: context(),
            model: "claude-opus-4-8",
            sessionId: "11111111-1111-4111-8111-111111111111",
        });

        for (const replay of [codex, grok, anthropic]) {
            const encoded = JSON.stringify(replay);
            expect(encoded).toContain(INTERNAL_CALL_ID);
            expect(encoded).not.toContain(PROVIDER_CALL_ID);
        }
        const claudeReplay = JSON.stringify({
            entries: claude.entries(),
            message: claude.message,
        });
        expect(claudeReplay).toContain(INTERNAL_CALL_ID);
        expect(claudeReplay).not.toContain(PROVIDER_CALL_ID);
    });

    it("accepts a context tool call without vendor identity metadata", () => {
        const missing = context();
        const assistant = missing.messages[1];
        if (assistant?.role !== "assistant") expect.fail("Missing assistant fixture.");
        const malformed: SessionContext = {
            ...missing,
            messages: [
                missing.messages[0]!,
                {
                    ...assistant,
                    content: assistant.content.map((block) =>
                        block.type === "tool_call" ? { ...block, vendor: undefined } : block,
                    ),
                },
                missing.messages[2]!,
            ],
        };

        expect(JSON.stringify(toOpenAIResponseInput(malformed))).toContain(INTERNAL_CALL_ID);
    });

    it("replays full context after Base replaces a live Codex tool-call ID", () => {
        const previousRequest = {
            model: "gpt-5.6-sol",
            input: [{ type: "message", role: "user", content: "Inspect it." }],
        };
        const nativeToolCall = {
            type: "function_call",
            call_id: PROVIDER_CALL_ID,
            name: "inspect",
            arguments: "{}",
        };
        const rebuilt = {
            model: "gpt-5.6-sol",
            input: toOpenAIResponseInput(context()),
        };

        expect(JSON.stringify(rebuilt.input)).toContain(INTERNAL_CALL_ID);
        expect(
            getCodexIncrementalInput(previousRequest, [nativeToolCall], rebuilt),
        ).toBeUndefined();
    });

    it("exposes the provider stream ID directly and leaves vendor metadata unchanged", () => {
        const accumulator = new SessionAssistantMessageAccumulator();
        accumulator.add({
            type: "toolcall_start",
            callId: PROVIDER_CALL_ID,
            name: "inspect",
            vendor: { provider: "test" },
        });
        accumulator.add({
            type: "toolcall_end",
            callId: PROVIDER_CALL_ID,
            arguments: "{}",
        });

        expect(accumulator.message()).toEqual({
            role: "assistant",
            content: [
                {
                    type: "tool_call",
                    callId: PROVIDER_CALL_ID,
                    name: "inspect",
                    arguments: "{}",
                    vendor: { provider: "test" },
                },
            ],
        });
    });
});
