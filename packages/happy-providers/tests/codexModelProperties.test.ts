import { describe, expect, it } from "vitest";

import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { getCodexModelProperties } from "@/vendors/codex/impl/getCodexModelProperties.js";
import { isCodexV2Model } from "@/vendors/codex/impl/isCodexV2Model.js";
import { resolveCodexReasoningEffort } from "@/vendors/codex/impl/resolveCodexReasoningEffort.js";

describe("Codex model properties", () => {
    it("uses GPT-6 Astra's native Codex defaults and request profiles", () => {
        expect(getCodexModelProperties("gpt-6-astra")).toEqual({
            compactionHash: "3000",
            contextWindow: 272_000,
            defaultEffort: "low",
            responsesLite: true,
        });
        expect(resolveCodexReasoningEffort("gpt-6-astra", undefined)).toBe("low");
        expect(isCodexV2Model("gpt-6-astra")).toBe(true);

        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Astra instructions.", messages: [] },
            effort: "low",
            model: "gpt-6-astra",
            promptCacheKey: "astra-session",
            tools: [],
        });

        expect(request).toMatchObject({
            model: "gpt-6-astra",
            parallel_tool_calls: false,
            reasoning: { context: "all_turns", effort: "low" },
            text: { verbosity: "low" },
            input: [
                {
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: "Astra instructions." }],
                },
            ],
        });
        expect(request).not.toHaveProperty("instructions");
        expect(request).not.toHaveProperty("tools");

        const standardRequest = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Astra instructions.", messages: [] },
            effort: "low",
            model: "gpt-6-astra",
            parallelToolCalls: true,
            promptCacheKey: "astra-session",
            tools: [],
        });

        expect(standardRequest).toMatchObject({
            instructions: "Astra instructions.",
            parallel_tool_calls: true,
            tools: [],
        });
        expect(standardRequest.reasoning).not.toHaveProperty("context");
    });
});
