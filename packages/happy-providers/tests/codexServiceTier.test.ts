import { describe, expect, it } from "vitest";

import { createCodexBedrockRequest } from "@/vendors/codex/impl/createCodexBedrockRequest.js";
import { parseCodexServiceTier } from "@/vendors/codex/impl/codexServiceTier.js";
import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { createResponsesLiteSseRequest } from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import { stampCodexWebSocketRequest } from "@/vendors/codex/impl/stampCodexWebSocketRequest.js";

describe("Codex service tier", () => {
    it.each([undefined, "priority", "ultrafast"])(
        "preserves Astra's %s tier across native request envelopes",
        (tier) => {
            const serviceTier = parseCodexServiceTier(tier);
            expect(serviceTier).toBe(tier);
            for (const parallelToolCalls of [false, true]) {
                const request = createCodexCliRequest({
                    clientMetadata: {},
                    context: { instructions: "Test", messages: [] },
                    effort: "low",
                    model: "gpt-6-astra",
                    parallelToolCalls,
                    promptCacheKey: "session",
                    ...(serviceTier === undefined ? {} : { serviceTier }),
                    tools: [],
                });
                expect(request.service_tier).toBe(tier);
                expect(stampCodexWebSocketRequest(request).service_tier).toBe(tier);
                expect(createResponsesLiteSseRequest(request, []).service_tier).toBe(tier);
                expect(createCodexBedrockRequest(request).service_tier).toBeUndefined();
            }
        },
    );

    it("writes the priority tier to the native request", () => {
        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Test", messages: [] },
            effort: "low",
            model: "gpt-5.6-sol",
            promptCacheKey: "session",
            serviceTier: "priority",
            tools: [],
        });

        expect(request.service_tier).toBe("priority");
    });

    it("rejects a tier Codex does not own before request construction", () => {
        expect(() => parseCodexServiceTier("economy")).toThrow(
            'Codex does not support service tier "economy".',
        );
    });

    it("drops the tier on the Codex Bedrock route", () => {
        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Test", messages: [] },
            effort: "low",
            model: "openai.gpt-5.6-sol",
            promptCacheKey: "session",
            serviceTier: "priority",
            tools: [],
        });

        expect(createCodexBedrockRequest(request).service_tier).toBeUndefined();
    });
});
