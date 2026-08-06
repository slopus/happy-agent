import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";

// Mantle reports a stale AWS signature as a 401 whose body carries "Signature expired:". This
// body is reconstructed from the native client's own matcher in
// codex-rs/model-provider/src/amazon_bedrock/error.rs rather than captured, because reaching
// Bedrock requires credentials. Replace it with a real recorded response when one is seen.
const EXPIRED_SIGNATURE_BODY = JSON.stringify({
    message:
        "Signature expired: 20260724T000000Z is now earlier than 20260724T001500Z (20260724T003000Z - 15 min.)",
});

describe("Codex on Bedrock rejections", () => {
    it("names the stale AWS credential instead of repeating a bare authorization failure", async () => {
        const message = await runOnce(401, EXPIRED_SIGNATURE_BODY);

        expect(message).toBe(
            "Amazon Bedrock rejected the request because its AWS signature has expired. " +
                "Refresh your AWS credentials and retry. If AWS_BEARER_TOKEN_BEDROCK is set, " +
                "update or unset it, then start a new session.",
        );
    });

    // AWS reports failures as a top-level `message`, while the OpenAI SDK only reads a nested
    // `error`. Left alone it discards the entire body and reports "no body", so every Bedrock
    // rejection would arrive with nothing a person could act on.
    it("keeps the diagnostic AWS reports outside the OpenAI error envelope", async () => {
        const message = await runOnce(
            403,
            JSON.stringify({ message: "User is not authorized to invoke this operation." }),
        );

        expect(message).toBe("403 User is not authorized to invoke this operation.");
    });
});

async function runOnce(status: number, body: string): Promise<string | undefined> {
    const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(body);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Codex Bedrock test server port.");
    }
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "bedrock-expired-signature-token",
    });
    if (credential === null) throw new Error("Expected a Bedrock test credential.");
    const provider = new CodexProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}`,
        model: "openai.gpt-5.6-sol",
        inferenceMaxRetries: 0,
    });
    const session = await provider.session("expired-signature-session", {
        instructions: "Test",
        tools: [],
    });

    try {
        const events: SessionEvent[] = [];
        for await (const event of session.run({
            context: { messages: [{ role: "user", content: "Hello." }] },
        })) {
            events.push(event);
        }

        const done = events.at(-1);
        if (done?.type !== "done" || done.state !== "error") {
            throw new Error("Expected the run to end in an error.");
        }
        return done.message;
    } finally {
        session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
