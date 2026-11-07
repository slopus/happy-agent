import { testContext } from "./testContext.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import {
    bedrockRuntimeEndpoint,
    bedrockRuntimeOpenAIEndpoint,
} from "@/vendors/bedrock/impl/bedrockConstants.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Bedrock endpoints in the China partition", () => {
    it.each([
        ["cn-north-1", "https://bedrock-runtime.cn-north-1.amazonaws.com.cn"],
        ["cn-northwest-1", "https://bedrock-runtime.cn-northwest-1.amazonaws.com.cn"],
        ["us-east-1", "https://bedrock-runtime.us-east-1.amazonaws.com"],
    ])("synthesizes the Runtime endpoint for %s", (region, expected) => {
        expect(bedrockRuntimeEndpoint(region)).toBe(expected);
        expect(bedrockRuntimeOpenAIEndpoint(region)).toBe(`${expected}/openai/v1`);
    });

    it.each([
        ["cn-north-1", "bedrock-runtime.cn-north-1.amazonaws.com.cn"],
        ["us-east-2", "bedrock-runtime.us-east-2.amazonaws.com"],
    ])("sends Anthropic Runtime requests in %s to its partition's host", async (region, host) => {
        const urls: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            urls.push(input instanceof Request ? input.url : String(input));
            return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                headers: { "content-type": "text/event-stream" },
            });
        });
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-china-token",
        });
        if (credential === null) throw new Error("Expected a Bedrock test credential.");
        const provider = new AnthropicBedrockProvider({
            credential,
            model: "global.anthropic.claude-sonnet-5-5",
            region,
            transport: "runtime",
        });
        const session = await provider.session("china-session", { instructions: "", tools: [] });
        try {
            for await (const _event of session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
                },
            })) {
                // Draining the stream is what performs the request under test.
            }
        } finally {
            session.destroy();
        }
        expect(urls.map((url) => new URL(url).host)).toEqual([host]);
    });
});
