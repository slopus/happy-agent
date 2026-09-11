import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import {
    reviewerModelForAgent,
    reviewerModelsForAgent,
    type AutoReviewerRoute,
} from "../../sources/auto/impl/reviewerModelForAgent.js";

function model(
    providerId: string,
    id: string,
    effortLevels: readonly SessionReasoningEffort[],
    defaultEffort: SessionReasoningEffort,
): AgentModel {
    return { providerId, id, name: id, effortLevels, defaultEffort };
}

const active = (
    providerId: string,
    modelId: string,
    effort: SessionReasoningEffort,
): AutoReviewerRoute => ({ providerId, modelId, effort });

describe("reviewerModelForAgent", () => {
    it("lists each same-provider fallback once in precedence order, retaining active effort", () => {
        const ids = [
            "anthropic/sonnet-5",
            "openai/codex-auto-review",
            "openai/gpt-5.4",
            "anthropic/opus-5",
        ];
        const models = ids.map((id) => model("bedrock", id, ["low", "medium"], "medium"));
        const routes = reviewerModelsForAgent({
            models,
            active: active("bedrock", "anthropic/opus-5", "low"),
        });
        expect(routes.map((route) => route.modelId)).toEqual(ids);
        expect(routes.at(-1)?.effort).toBe("low");
        expect(
            reviewerModelsForAgent({
                models,
                active: active("bedrock", "openai/gpt-5.4", "low"),
            }).map((route) => route.modelId),
        ).toEqual(["openai/codex-auto-review", "openai/gpt-5.4"]);
    });

    it("selects_codex_auto_review_without_exposing_it_in_the_public_catalog", () => {
        const models = [
            model("codex", "openai/gpt-5.6-sol", ["low", "medium", "high"], "medium"),
            model("codex", "openai/codex-auto-review", ["low", "medium", "high", "xhigh"], "low"),
        ];

        expect(
            reviewerModelForAgent({
                models,
                active: active("codex", "openai/gpt-5.6-sol", "medium"),
            }),
        ).toEqual({ providerId: "codex", modelId: "openai/codex-auto-review", effort: "low" });
    });

    it("selects_sonnet_for_opus_and_fable_on_the_same_provider", () => {
        const sonnetLevels: SessionReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
        const models = [
            model("claude", "anthropic/opus-5", sonnetLevels, "medium"),
            model("claude", "anthropic/fable-5", sonnetLevels, "medium"),
            model("claude", "anthropic/sonnet-5", sonnetLevels, "medium"),
        ];

        expect(
            reviewerModelForAgent({ models, active: active("claude", "anthropic/opus-5", "high") }),
        ).toEqual({ providerId: "claude", modelId: "anthropic/sonnet-5", effort: "medium" });
        expect(
            reviewerModelForAgent({ models, active: active("claude", "anthropic/fable-5", "low") }),
        ).toEqual({ providerId: "claude", modelId: "anthropic/sonnet-5", effort: "medium" });
    });

    it("prefers codex auto review over gpt-5.4 when the provider has both", () => {
        const models = [
            model("codex", "openai/gpt-5.6-sol", ["low", "medium"], "medium"),
            model("codex", "openai/codex-auto-review", ["low", "medium", "high", "xhigh"], "low"),
            model("codex", "openai/gpt-5.4", ["off", "low", "medium", "high", "xhigh"], "medium"),
        ];

        expect(
            reviewerModelForAgent({
                models,
                active: active("codex", "openai/gpt-5.6-sol", "medium"),
            }).modelId,
        ).toBe("openai/codex-auto-review");
    });

    it("falls through past a missing same-provider sonnet route for an opus conversation", () => {
        const models = [
            model("codex", "anthropic/opus-5", ["low", "medium"], "medium"),
            model("codex", "openai/codex-auto-review", ["low", "medium", "high", "xhigh"], "low"),
        ];

        expect(
            reviewerModelForAgent({ models, active: active("codex", "anthropic/opus-5", "medium") })
                .modelId,
        ).toBe("openai/codex-auto-review");
    });

    it("selects_bedrock_gpt_5_4_and_falls_back_to_the_active_model", () => {
        const bedrock = [
            model("bedrock", "openai/gpt-5.6-terra", ["low", "medium", "high"], "medium"),
            model("bedrock", "openai/gpt-5.4", ["off", "low", "medium", "high", "xhigh"], "medium"),
        ];

        expect(
            reviewerModelForAgent({
                models: bedrock,
                active: active("bedrock", "openai/gpt-5.6-terra", "high"),
            }),
        ).toEqual({ providerId: "bedrock", modelId: "openai/gpt-5.4", effort: "medium" });

        // No hidden reviewer route for this provider, but the active route resolves in the catalog,
        // so the reviewer keeps the active provider/model/effort exactly as v1's final fallback.
        const grok = [model("grok", "xai/grok-4.5", ["low", "medium", "high"], "high")];
        expect(
            reviewerModelForAgent({
                models: grok,
                active: active("grok", "xai/grok-4.5", "medium"),
            }),
        ).toEqual({ providerId: "grok", modelId: "xai/grok-4.5", effort: "medium" });
    });

    it("returns_unavailable_when_no_private_or_active_route_can_resolve", () => {
        const models = [model("codex", "openai/gpt-5.6-sol", ["low", "medium"], "medium")];

        expect(() =>
            reviewerModelForAgent({
                models,
                active: active("bedrock", "openai/unknown", "low"),
            }),
        ).toThrow();
    });

    it("never borrows a hidden route from another provider", () => {
        const models = [
            model("other", "openai/codex-auto-review", ["low", "medium"], "low"),
            model("active", "openai/gpt-5.6-sol", ["low", "medium"], "medium"),
        ];

        expect(
            reviewerModelForAgent({
                models,
                active: active("active", "openai/gpt-5.6-sol", "low"),
            }),
        ).toEqual({
            providerId: "active",
            modelId: "openai/gpt-5.6-sol",
            effort: "low",
        });
    });

    it("only recognizes the exact Opus and Fable model prefixes", () => {
        const models = [
            model("claude", "anthropic/opussomething", ["low", "medium"], "medium"),
            model("claude", "openai/codex-auto-review", ["low", "medium"], "low"),
        ];

        expect(
            reviewerModelForAgent({
                models,
                active: active("claude", "anthropic/opussomething", "medium"),
            }),
        ).toEqual({
            providerId: "claude",
            modelId: "openai/codex-auto-review",
            effort: "low",
        });
    });
});
