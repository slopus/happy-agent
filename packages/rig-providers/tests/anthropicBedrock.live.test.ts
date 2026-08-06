import { describe, expect, it } from "vitest";

import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const LIVE =
    process.env.RIG_LIVE_TEST === "1" && process.env.AWS_BEARER_TOKEN_BEDROCK !== undefined;

describe.skipIf(!LIVE)("Anthropic Bedrock live session", () => {
    it("runs direct inference through preferred Bedrock Mantle", { timeout: 120_000 }, async () => {
        const credential = await BedrockBearerTokenCredential.tryLoad({
            env: process.env,
        });
        if (credential === null) {
            expect.fail("Missing AWS_BEARER_TOKEN_BEDROCK.");
        }
        const provider = new AnthropicBedrockProvider({
            credential,
            model: "anthropic/opus-4-8",
        });
        const session = await provider.session(`anthropic-bedrock-live-${Date.now()}`, {
            instructions: "Follow exact response instructions. Do not add punctuation.",
            tools: [],
        });

        try {
            const events = await collectSessionEvents(
                session.run({
                    effort: "low",
                    context: {
                        messages: [
                            {
                                role: "user",
                                content: "Reply with exactly ANTHROPIC_BEDROCK_LIVE_OK",
                            },
                        ],
                    },
                }),
            );
            expect(textFromSessionEvents(events).trim()).toBe("ANTHROPIC_BEDROCK_LIVE_OK");
            expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        } finally {
            session.destroy();
        }
    });

    it(
        "replays a native compaction checkpoint in a later turn",
        { timeout: 300_000 },
        async () => {
            const credential = await BedrockBearerTokenCredential.tryLoad({
                env: process.env,
            });
            if (credential === null) {
                expect.fail("Missing AWS_BEARER_TOKEN_BEDROCK.");
            }
            const provider = new AnthropicBedrockProvider({
                credential,
                model: "anthropic/sonnet-5",
            });
            const session = await provider.session(
                `anthropic-bedrock-live-compaction-${Date.now()}`,
                {
                    instructions: "You are a helpful assistant.",
                    tools: [],
                },
            );

            try {
                const compaction = await session.compact({
                    context: {
                        messages: [
                            { role: "user", content: "My favorite color is teal. Remember it." },
                            { role: "assistant", content: "Got it, your favorite color is teal." },
                            {
                                role: "user",
                                content:
                                    "Here is a long document to pad the context past the native compaction trigger:\n" +
                                    "The quick brown fox jumps over the lazy dog. ".repeat(30_000),
                            },
                        ],
                    },
                });
                if (compaction.status !== "completed" || compaction.compaction === undefined) {
                    throw new Error(`Compaction did not complete: ${JSON.stringify(compaction)}`);
                }

                const events = await collectSessionEvents(
                    session.run({
                        effort: "low",
                        context: {
                            messages: [
                                compaction.compaction,
                                {
                                    role: "user",
                                    content: "What is my favorite color? Reply with one word.",
                                },
                            ],
                        },
                    }),
                );
                expect(textFromSessionEvents(events).toLowerCase()).toContain("teal");
                expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
            } finally {
                session.destroy();
            }
        },
    );
});
