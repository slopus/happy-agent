import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import { toClaudeSdkOptions } from "@/vendors/claude/impl/toClaudeSdkOptions.js";
import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { createGrokOpenAIRequest } from "@/vendors/grok/impl/createGrokOpenAIRequest.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const schema = Type.Object(
    {
        title: Type.String(),
        recap: Type.String(),
    },
    { additionalProperties: false },
);
const structuredOutput = { name: "session_metadata", schema };

describe("provider structured output", () => {
    it("uses strict native Responses JSON schema output for Codex", () => {
        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Create metadata.", messages: [] },
            effort: "off",
            model: "gpt-5.5",
            promptCacheKey: "session",
            structuredOutput,
            tools: [],
        });

        expect(request.text).toEqual({
            verbosity: "low",
            format: {
                type: "json_schema",
                name: "session_metadata",
                schema,
                strict: true,
            },
        });
    });

    it("uses strict native Responses JSON schema output for Grok", () => {
        const request = createGrokOpenAIRequest({
            apiModelId: "grok-4.5",
            context: { instructions: "Create metadata.", messages: [] },
            structuredOutput,
            tools: [],
        });

        expect(request.text).toEqual({
            format: {
                type: "json_schema",
                name: "session_metadata",
                schema,
                strict: true,
            },
        });
    });

    it("uses native Anthropic structured output for Bedrock", () => {
        const request = createAnthropicRequest({
            context: { instructions: "Create metadata.", messages: [] },
            effort: "off",
            model: "us.anthropic.claude-sonnet-5",
            structuredOutput,
            tools: [],
        });

        expect(request.betas).toContain("structured-outputs-2025-12-15");
        expect(request.output_config).toEqual({
            format: {
                type: "json_schema",
                schema,
            },
        });
    });

    it("uses the Claude Code SDK native structured output option", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");

        const options = toClaudeSdkOptions({
            context: { instructions: "Create metadata.", messages: [] },
            credential,
            env: {},
            model: "claude-sonnet-5",
            sessionId: "session",
            structuredOutput,
            systemPrompt: "",
            tools: [],
        });

        expect(options.outputFormat).toEqual({
            type: "json_schema",
            schema,
        });
    });

    it("surfaces the Claude SDK structured result as raw JSON text", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const session = new ClaudeSession("session", {
            credential,
            instructions: "Create metadata.",
            model: "claude-sonnet-5",
            query: (() => {
                async function* messages() {
                    yield {
                        type: "result",
                        subtype: "success",
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        num_turns: 1,
                        result: "",
                        stop_reason: "end_turn",
                        structured_output: {
                            title: "Structured session metadata",
                            recap: "The provider enforced the requested schema.",
                        },
                        total_cost_usd: 0,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 1,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        modelUsage: {},
                        permission_denials: [],
                        uuid: "result-id",
                        session_id: "session",
                    };
                }
                const generator = messages();
                return Object.assign(generator, { close: () => {} });
            }) as unknown as ClaudeSdkQuery,
            tools: [],
        });

        const events = await collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Create metadata." }] },
                structuredOutput,
            }),
        );

        expect(textFromSessionEvents(events)).toBe(
            '{"title":"Structured session metadata","recap":"The provider enforced the requested schema."}',
        );
    });
});
