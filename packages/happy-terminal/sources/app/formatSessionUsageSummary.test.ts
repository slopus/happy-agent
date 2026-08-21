import { describe, expect, it } from "vitest";

import type { GetSessionUsageResponse, Usage } from "../protocol/index.js";
import { formatSessionUsageSummary } from "./formatSessionUsageSummary.js";

describe("formatSessionUsageSummary", () => {
    it("keeps provider/model attribution while folding the subtree into one session line", () => {
        const summary: GetSessionUsageResponse = {
            currentProviderId: "codex",
            groups: [
                group("grok", "xai/grok-4.6", 1_000, 100, 600),
                group("codex", "openai/gpt-5.6-luna", 500, 50, 400),
                group("codex", "openai/gpt-5.6-sol", 800, 80, 700),
            ],
            context: {
                approximate: false,
                modelId: "openai/gpt-5.6-sol",
                providerId: "codex",
                requestedModelId: "openai/gpt-5.6-sol",
                totalTokens: 320,
            },
            quotas: [],
        };

        const output = formatSessionUsageSummary(summary, [
            model("grok", "xai/grok-4.6", "Grok 4.6"),
            model("codex", "openai/gpt-5.6-luna", "GPT-5.6 Luna"),
            model("codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol"),
        ]);

        expect(output).toContain("Grok Build\n  Grok 4.6");
        expect(output).toContain("Codex\n  GPT-5.6 Luna");
        expect(output).toContain("  GPT-5.6 Sol");
        expect(output).toContain("Input: 1k");
        expect(output).toContain("Context: 320 / 500k");
        expect(output).toContain("Session work: 830 used · 74% cache hit");
    });

    it("clamps fresh input per attributed model before folding", () => {
        const summary: GetSessionUsageResponse = {
            currentProviderId: "codex",
            groups: [
                group("grok", "xai/grok-4.6", 100, 0, 120),
                group("codex", "openai/gpt-5.6-sol", 100, 0, 0),
            ],
            quotas: [],
        };
        expect(formatSessionUsageSummary(summary, [])).toContain(
            "Session work: 100 used · 60% cache hit",
        );
    });
});

function group(
    providerId: string,
    modelId: string,
    input: number,
    output: number,
    cacheRead: number,
): GetSessionUsageResponse["groups"][number] {
    return {
        kind: "attributed",
        modelId,
        providerId,
        requestedModelId: modelId,
        usage: usage(input, output, cacheRead),
    };
}

function model(providerId: string, id: string, name: string) {
    return {
        providerId,
        model: {
            id,
            name,
            contextWindow: 500_000,
            defaultThinkingLevel: "medium",
            thinkingLevels: ["low", "medium", "high"],
        },
    };
}

function usage(input: number, output: number, cacheRead: number): Usage {
    return {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
