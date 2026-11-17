import { expect, it } from "vitest";
import { codexCliAgent } from "@/vendors/foreignAgents/codexCliAgent.js";

it("uses Terra's published subscription limits in the CLI fallback and selector", () => {
    expect(
        codexCliAgent.models.find((model) => model.id === "codex-cli/gpt-6.1-terra"),
    ).toMatchObject({
        contextWindow: 500_000,
        defaultEffort: "low",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(
        codexCliAgent.modelsFromSelector([{ value: "gpt-6.1-terra", name: "GPT-6.1 Terra" }])[0],
    ).toMatchObject({
        contextWindow: 500_000,
    });
});

it("offers GPT-6.2 Sol and Astra first in the CLI fallback with their published windows", () => {
    expect(codexCliAgent.models.slice(0, 2)).toMatchObject([
        { id: "codex-cli/gpt-6.2-sol", contextWindow: 500_000, defaultEffort: "high" },
        { id: "codex-cli/gpt-6.2-astra", contextWindow: 272_000, defaultEffort: "high" },
    ]);
});
