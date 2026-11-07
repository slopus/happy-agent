import { testContext } from "./testContext.js";

import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";

describe("Anthropic Bedrock endpoint with a query string", () => {
    it("rewrites the Runtime path and keeps the endpoint's query", async () => {
        expect(await requestedUrl("runtime", "/bedrock?route=fixture")).toBe(
            "/bedrock/model/global.anthropic.claude-sonnet-5-5/invoke-with-response-stream?route=fixture",
        );
    });

    it("keeps the Mantle path and both the canonical marker and the endpoint's query", async () => {
        expect(await requestedUrl("mantle", "/bedrock?route=fixture")).toBe(
            "/bedrock/v1/messages?beta=true&route=fixture",
        );
    });
});

async function requestedUrl(
    transport: AnthropicBedrockTransport,
    endpointPath: string,
): Promise<string | undefined> {
    let url: string | undefined;
    const server = createServer((request, response) => {
        url = request.url;
        request.resume();
        request.once("end", () => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Anthropic Bedrock test server port.");
    }
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "bedrock-query-token",
    });
    if (credential === null) throw new Error("Expected a Bedrock test credential.");
    const provider = new AnthropicBedrockProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}${endpointPath}`,
        model: "global.anthropic.claude-sonnet-5-5",
        region: "us-east-2",
        transport,
    });
    const session = await provider.session("endpoint-query-session", {
        instructions: "",
        tools: [],
    });
    try {
        for await (const _event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text" as const, text: "Hello." }] }],
            },
        })) {
            // Draining the stream is what performs the request under test.
        }
    } finally {
        session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return url;
}
