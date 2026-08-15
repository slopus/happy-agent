import { describe, expect, it } from "vitest";

import type { GetSessionUsageResponse } from "../protocol/index.js";
import { defineTestModel as defineModel } from "../testing/defineTestModel.js";
import { formatSessionUsageSummary } from "./formatSessionUsageSummary.js";

const codex = defineModel({
    contextWindow: 200_000,
    defaultThinkingLevel: "high",
    id: "openai/gpt-5.6",
    name: "GPT-5.6",
    thinkingLevels: ["high"],
});

describe("formatSessionUsageSummary", () => {
    it("renders detailed compact tokens, both quota windows, and context", () => {
        expect(
            formatSessionUsageSummary(summary(), [{ model: codex, providerId: "codex" }], 1_000),
        ).toBe(
            [
                "Codex",
                "  GPT-5.6",
                "    1.2k input · 100 output · 40 cache read · 30 cache write · 20 reasoning",
                "    Context: 1.3k / 200k · 99.4% left",
                "  Account quota",
                "    5-hour: 68% left · resets in 2h 14m",
                "    Weekly: 79% left · resets in 6d 2h",
                "Session tokens: 1.4k",
            ].join("\n"),
        );
    });

    it("marks approximate context and unavailable windows without estimates", () => {
        const value = summary();
        value.context = { ...value.context!, approximate: true };
        value.quotas = [
            {
                providerId: "codex",
                quota: {
                    capturedAt: 1_000,
                    source: "codex",
                    windows: {
                        fiveHour: { status: "unavailable" },
                        weekly: { status: "unavailable" },
                    },
                },
            },
        ];

        const text = formatSessionUsageSummary(value, [{ model: codex, providerId: "codex" }]);
        expect(text).toContain("5-hour: unavailable");
        expect(text).toContain("Weekly: unavailable");
        expect(text).toContain("Context: ~1.3k / 200k");
    });

    it("shows authoritative Claude cost and keeps provider sections separate", () => {
        const value = summary();
        value.currentProviderId = "claude";
        value.groups = [
            ...value.groups,
            {
                kind: "attributed",
                modelId: "anthropic/sonnet-4-6",
                providerId: "claude",
                requestedModelId: "anthropic/sonnet-4-6",
                usage: {
                    ...usage(100, 20, 0, 0, 120),
                    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0.1234 },
                },
            },
        ];

        const text = formatSessionUsageSummary(value, [{ model: codex, providerId: "codex" }]);
        expect(text).toContain("Claude Code\n  Sonnet 4 6\n    100 input · 20 output");
        expect(text).toContain("· $0.12");
    });

    it("formats sub-one-percent quota values without a leading zero", () => {
        const value = summary();
        value.quotas[0]!.quota.windows.fiveHour = {
            capturedAt: 1_000,
            resetsAt: 2_000,
            status: "available",
            usedPercent: 99.8,
        };

        const text = formatSessionUsageSummary(
            value,
            [{ model: codex, providerId: "codex" }],
            1_000,
        );
        expect(text).toContain("5-hour: .2% left");
    });

    it("uses compact million-scale token labels", () => {
        const value = summary();
        value.groups = [
            {
                kind: "attributed",
                modelId: codex.id,
                providerId: "codex",
                requestedModelId: codex.id,
                usage: usage(1_000_000, 0, 0, 0, 1_000_000),
            },
        ];
        value.sessionTokenCount = { lastContextTokens: 1_000_000, totalTokens: 1_000_000 };

        const text = formatSessionUsageSummary(value, [{ model: codex, providerId: "codex" }]);
        expect(text).toContain("1m input · 0 output");
        expect(text).toContain("Session tokens: 1m");
    });

    it("renders current context before the selected model has a usage group", () => {
        const value = summary();
        value.groups = [];
        value.quotas = [];
        value.context = { ...value.context!, approximate: true, totalTokens: 600 };

        const text = formatSessionUsageSummary(value, [{ model: codex, providerId: "codex" }]);

        expect(text).toContain("Codex\n  GPT-5.6\n    Context: ~600 / 200k · 99.7% left");
        expect(text).toContain("Session tokens: 1.4k");
    });

    it.each([
        ["claude", "Claude Code"],
        ["grok", "Grok Build"],
    ])("uses the shared product name for the %s provider", (providerId, productName) => {
        const value = summary();
        delete value.context;
        value.currentProviderId = providerId;
        value.groups = [];
        value.quotas = [];

        expect(formatSessionUsageSummary(value, []).split("\n")[0]).toBe(productName);
    });
});

function summary(): GetSessionUsageResponse {
    return {
        context: {
            approximate: false,
            modelId: codex.id,
            providerId: "codex",
            requestedModelId: codex.id,
            totalTokens: 1_300,
        },
        currentProviderId: "codex",
        groups: [
            {
                kind: "attributed",
                modelId: codex.id,
                providerId: "codex",
                requestedModelId: codex.id,
                usage: { ...usage(1_200, 100, 40, 30, 1_370), reasoning: 20 },
            },
        ],
        sessionTokenCount: { lastContextTokens: 1_370, totalTokens: 1_370 },
        quotas: [
            {
                providerId: "codex",
                quota: {
                    capturedAt: 1_000,
                    source: "codex",
                    windows: {
                        fiveHour: {
                            capturedAt: 1_000,
                            resetsAt: 1_000 + (2 * 60 + 14) * 60_000,
                            status: "available",
                            usedPercent: 32,
                        },
                        weekly: {
                            capturedAt: 1_000,
                            resetsAt: 1_000 + (6 * 24 + 2) * 60 * 60_000,
                            status: "available",
                            usedPercent: 21,
                        },
                    },
                },
            },
        ],
    };
}

function usage(
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    total: number,
) {
    return {
        cacheRead,
        cacheWrite,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: total,
    };
}
