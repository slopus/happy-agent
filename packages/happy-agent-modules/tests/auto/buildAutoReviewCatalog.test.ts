import type { AgentModel } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import { buildAutoReviewCatalog } from "../../sources/auto/impl/buildAutoReviewCatalog.js";

function model(providerId: string, id: string): AgentModel {
    return { providerId, id, name: id, effortLevels: ["low", "medium"], defaultEffort: "medium" };
}

function typeOfFrom(
    kinds: Readonly<Record<string, ProviderModelCompatibilityType>>,
): (providerId: string) => ProviderModelCompatibilityType | null {
    return (providerId) => kinds[providerId] ?? null;
}

function find(
    catalog: readonly AgentModel[],
    providerId: string,
    id: string,
): AgentModel | undefined {
    return catalog.find((entry) => entry.providerId === providerId && entry.id === id);
}

describe("buildAutoReviewCatalog", () => {
    it("copies every main model verbatim", () => {
        const models = [model("codex", "openai/gpt-5.6-sol")];
        const catalog = buildAutoReviewCatalog({ models, typeOf: typeOfFrom({ codex: "codex" }) });
        expect(find(catalog, "codex", "openai/gpt-5.6-sol")).toEqual(models[0]);
    });

    it("adds hidden codex-auto-review for a codex provider with low default and its effort range", () => {
        const catalog = buildAutoReviewCatalog({
            models: [model("codex", "openai/gpt-5.6-sol")],
            typeOf: typeOfFrom({ codex: "codex" }),
        });
        const hidden = find(catalog, "codex", "openai/codex-auto-review");
        expect(hidden).toBeDefined();
        expect(hidden?.defaultEffort).toBe("low");
        expect(hidden?.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    });

    it("adds native reviewer routes without resurrecting unavailable Bedrock Sonnet", () => {
        const catalog = buildAutoReviewCatalog({
            models: [model("claude", "anthropic/opus-5"), model("bedrock", "anthropic/opus-5")],
            typeOf: typeOfFrom({ claude: "claude", bedrock: "bedrock" }),
        });
        expect(find(catalog, "claude", "anthropic/sonnet-5")).toBeDefined();
        expect(find(catalog, "bedrock", "anthropic/sonnet-5")).toBeUndefined();
        expect(find(catalog, "bedrock", "openai/gpt-5.4")).toBeDefined();
        // A bedrock provider is not codex, so it gains no codex-auto-review route.
        expect(find(catalog, "bedrock", "openai/codex-auto-review")).toBeUndefined();
    });

    it("never overrides a route the main catalog already exposes", () => {
        const existing: AgentModel = {
            providerId: "codex",
            id: "openai/codex-auto-review",
            name: "Deployment override",
            effortLevels: ["high"],
            defaultEffort: "high",
        };
        const catalog = buildAutoReviewCatalog({
            models: [existing],
            typeOf: typeOfFrom({ codex: "codex" }),
        });
        const routes = catalog.filter(
            (entry) => entry.providerId === "codex" && entry.id === "openai/codex-auto-review",
        );
        expect(routes).toHaveLength(1);
        expect(routes[0]).toEqual(existing);
    });

    it("adds nothing for an unregistered provider kind", () => {
        const catalog = buildAutoReviewCatalog({
            models: [model("mystery", "some/model")],
            typeOf: typeOfFrom({}),
        });
        expect(catalog).toHaveLength(1);
    });

    it("asks for each provider compatibility type once even when routes repeat", () => {
        const calls: string[] = [];
        const catalog = buildAutoReviewCatalog({
            models: [model("codex", "openai/one"), model("codex", "openai/two")],
            typeOf: (providerId) => {
                calls.push(providerId);
                return "codex";
            },
        });

        expect(calls).toEqual(["codex"]);
        expect(
            catalog.filter(
                (entry) => entry.providerId === "codex" && entry.id === "openai/codex-auto-review",
            ),
        ).toHaveLength(1);
    });

    it("does not add reviewer routes for a provider whose type resolver returns null", () => {
        const catalog = buildAutoReviewCatalog({
            models: [model("unknown", "model")],
            typeOf: () => null,
        });

        expect(catalog.map((entry) => entry.id)).toEqual(["model"]);
    });
});
