import { describe, expect, it } from "vitest";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import { createOpenAIResponseRequest } from "@/protocol/responses/createOpenAIResponseRequest.js";
import { MINIMAL_RESPONSES_CAPABILITIES } from "@/protocol/responses/ResponsesCapabilities.js";
import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { createGrokOpenAIRequest } from "@/vendors/grok/impl/createGrokOpenAIRequest.js";

const context = { instructions: "Test instructions.", messages: [] };
const configurableRoutes = [
    {
        name: "native Responses",
        create: (effort: SessionReasoningEffort) =>
            createOpenAIResponseRequest({ context, effort, model: "gpt-6-astra" }),
    },
    {
        name: "native Codex",
        create: (effort: SessionReasoningEffort) =>
            createCodexCliRequest({
                context,
                effort,
                model: "gpt-6-astra",
                parallelToolCalls: true,
                clientMetadata: {},
                promptCacheKey: "test-session",
                tools: [],
            }),
    },
    {
        name: "Grok",
        create: (effort: SessionReasoningEffort) =>
            createGrokOpenAIRequest({ context, effort, apiModelId: "grok-4.5" }),
    },
];
const fixedRoutes = [
    {
        name: "Responses with reasoning disabled",
        create: (effort: SessionReasoningEffort) =>
            createOpenAIResponseRequest({
                context,
                effort,
                model: "open-model",
                capabilities: MINIMAL_RESPONSES_CAPABILITIES,
            }),
    },
    ...["grok-build", "grok-composer-2.5-fast"].map((apiModelId) => ({
        name: apiModelId,
        create: (effort: SessionReasoningEffort) =>
            createGrokOpenAIRequest({ context, effort, apiModelId }),
    })),
];

describe.each([...configurableRoutes, ...fixedRoutes])("$name request", ({ create }) => {
    it("rejects unsupported Ultra instead of omitting or downgrading it", () => {
        expect(() => create("ultra")).toThrow(
            "The Responses protocol does not support Ultra reasoning effort.",
        );
    });
});

describe.each(configurableRoutes)("$name request", ({ create }) => {
    it("preserves max effort", () => {
        expect(create("max").reasoning?.effort).toBe("max");
    });
});

describe.each(fixedRoutes)("$name request", ({ create }) => {
    it("keeps existing non-Ultra effort omission unchanged", () => {
        expect(create("max").reasoning?.effort).toBeUndefined();
    });
});
