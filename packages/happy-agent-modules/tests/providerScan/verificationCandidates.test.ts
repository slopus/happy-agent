import type { AgentModel } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import {
    verificationCandidates,
    verificationEffort,
} from "../../sources/providerScan/verificationCandidates.js";

describe("verificationCandidates", () => {
    it("orders a provider's models cheapest first and never offers Fable", () => {
        const models = [
            "anthropic/fable-5-2",
            "anthropic/opus-5-5",
            "anthropic/sonnet-5-5",
            "anthropic/haiku-5-5",
            "anthropic/fable-5-1",
            "anthropic/opus-5",
            "anthropic/sonnet-5",
            "anthropic/fable-5",
            "anthropic/fable-6",
        ].map((id) => model("claude", id));

        const { candidates, onlyFable } = verificationCandidates(models, "claude");

        expect(candidates.map(({ id }) => id)).toEqual([
            "anthropic/haiku-5-5",
            "anthropic/sonnet-5-5",
            "anthropic/sonnet-5",
            "anthropic/opus-5-5",
            "anthropic/opus-5",
        ]);
        expect(onlyFable).toBe(false);
    });

    it("ranks across vendors and leaves unranked models last in configuration order", () => {
        const models = [
            model("bedrock", "openai/gpt-6.2-astra"),
            model("bedrock", "zai/glm-5.3"),
            model("bedrock", "openai/gpt-6.2-sol"),
            model("bedrock", "anthropic/opus-5"),
            model("bedrock", "moonshotai/kimi-k3"),
            model("bedrock", "anthropic/sonnet-5"),
            model("bedrock", "openai/gpt-6.1-terra"),
            model("bedrock", "openai/gpt-6-luna"),
            model("other", "anthropic/haiku-5-5"),
        ];

        expect(verificationCandidates(models, "bedrock").candidates.map(({ id }) => id)).toEqual([
            "openai/gpt-6-luna",
            "anthropic/sonnet-5",
            "openai/gpt-6.1-terra",
            "openai/gpt-6.2-sol",
            "anthropic/opus-5",
            "openai/gpt-6.2-astra",
            "zai/glm-5.3",
            "moonshotai/kimi-k3",
        ]);
    });

    it("puts Composer before the full Grok models", () => {
        const models = ["xai/grok-4.7", "xai/grok-build", "xai/grok-composer-2.5-fast"].map((id) =>
            model("grok", id),
        );
        expect(verificationCandidates(models, "grok").candidates.map(({ id }) => id)).toEqual([
            "xai/grok-composer-2.5-fast",
            "xai/grok-4.7",
            "xai/grok-build",
        ]);
    });

    it("reports a provider that offers only Fable models", () => {
        const models = [
            model("bedrock", "anthropic/fable-5"),
            model("bedrock", "anthropic/fable-5-2"),
        ];
        expect(verificationCandidates(models, "bedrock")).toEqual({
            candidates: [],
            onlyFable: true,
        });
        expect(verificationCandidates([], "bedrock")).toEqual({ candidates: [], onlyFable: false });
    });
});

describe("verificationEffort", () => {
    it.each<[AgentModel["effortLevels"], AgentModel["defaultEffort"], string]>([
        [["off", "low", "medium", "high", "xhigh", "max"], "medium", "low"],
        [["low", "medium", "high", "xhigh", "max"], "medium", "low"],
        [["off", "minimal", "medium", "high"], "medium", "minimal"],
        [["off", "medium"], "off", "medium"],
        [["high", "xhigh"], "high", "high"],
        [["off", "high"], "off", "high"],
        [["off"], "off", "off"],
    ])("picks the cheapest effort of %j other than off", (effortLevels, defaultEffort, chosen) => {
        expect(
            verificationEffort({
                ...model("claude", "anthropic/sonnet-5"),
                defaultEffort,
                effortLevels,
            }),
        ).toBe(chosen);
    });
});

function model(providerId: string, id: string): AgentModel {
    return {
        defaultEffort: "medium",
        effortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        id,
        name: id,
        providerId,
    };
}
