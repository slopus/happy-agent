import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    messageMetadataSchema,
    storyQuoteSchema,
    toolPresentationSchema,
} from "../sources/protocol/messages.js";

describe("additive conversation presentations", () => {
    it("accepts answered choices and free text in the tool presentation union", () => {
        expect(
            Value.Check(toolPresentationSchema, {
                type: "user_input",
                questions: [
                    {
                        id: "scope",
                        header: "Release scope",
                        question: "Which release?",
                        multiSelect: false,
                        options: [{ label: "Preview", description: "Try the change." }],
                    },
                    {
                        id: "notes",
                        header: "Release notes",
                        question: "What should we mention?",
                        multiSelect: false,
                        options: [],
                    },
                ],
                answers: { scope: ["Preview"], notes: ["Preserves answered questions."] },
            }),
        ).toBe(true);
    });

    it("keeps metadata compatible when the sender has no explanation", () => {
        expect(Value.Check(messageMetadataSchema, {})).toBe(true);
        expect(
            Value.Check(messageMetadataSchema, {
                senderAgentId: "clh3am8s90000ml08dl0adtx1",
                senderAgentExplanation: "Validation results",
            }),
        ).toBe(true);
        expect(
            Value.Check(messageMetadataSchema, { senderAgentExplanation: "x".repeat(121) }),
        ).toBe(false);
    });

    it("quotes a replied story with an optional still frame", () => {
        const quote = {
            kind: "story",
            storyId: "q2v7m4wfx0e8c1hg9kz3b6np",
            agentId: "k8d2s0vqzj4m7ly1c5xh3rwe",
            userId: null,
            caption: "New onboarding is ready to try",
            expiresAt: 1755486400000,
            frame: { mimeType: "image/jpeg", thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" },
        };
        expect(Value.Check(storyQuoteSchema, quote)).toBe(true);
        expect(Value.Check(storyQuoteSchema, { ...quote, caption: null, frame: null })).toBe(true);
        const { expiresAt: _, ...partial } = quote;
        expect(Value.Check(storyQuoteSchema, partial)).toBe(false);
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t" });
        expect(client.storyQuoteFrameUrl("agent1", "message1")).toBe(
            "http://agent.local/v0/agents/agent1/messages/message1/story-frame",
        );
    });
});
