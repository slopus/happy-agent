import { expect, it } from "vitest";
import { codexCliAgent } from "@/vendors/foreignAgents/codexCliAgent.js";
import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";
import { opencodeAgent } from "@/vendors/foreignAgents/opencodeAgent.js";
import { acpGenericAgent } from "@/vendors/foreignAgents/acpGenericAgent.js";

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

it("preserves Ultra when the Codex model selector advertises it", () => {
    expect(
        codexCliAgent.modelsFromSelector([
            {
                value: "gpt-6-astra",
                name: "GPT-6 Astra",
                meta: { efforts: ["low", "max", "ultra"], defaultEffort: "ultra" },
            },
        ])[0],
    ).toMatchObject({
        id: "codex-cli/gpt-6-astra",
        effortLevels: ["low", "max", "ultra"],
        defaultEffort: "ultra",
    });
});

it("uses advertised efforts for a future model absent from the fallback catalog", () => {
    const value = "gpt-future-test-model";
    expect(codexCliAgent.models.some((model) => model.id === `codex-cli/${value}`)).toBe(false);

    const [advertised] = codexCliAgent.modelsFromSelector([
        {
            value,
            name: "Future model fixture",
            meta: { efforts: ["high", "ultra"], defaultEffort: "ultra" },
        },
    ]);
    expect(advertised).toMatchObject({
        id: `codex-cli/${value}`,
        effortLevels: ["high", "ultra"],
        defaultEffort: "ultra",
    });
    expect(codexCliAgent.profile.modelOptions?.(advertised!.id, advertised!.defaultEffort)).toEqual(
        [
            { configId: "model", value },
            { configId: "reasoning_effort", value: "ultra" },
        ],
    );

    const [unsupported, unspecified] = codexCliAgent.modelsFromSelector([
        {
            value,
            name: "Future model fixture",
            meta: { efforts: ["high"], defaultEffort: "ultra" },
        },
        { value, name: "Future model fixture" },
    ]);
    expect(unsupported).toMatchObject({ effortLevels: ["high"], defaultEffort: "high" });
    expect(unspecified).toMatchObject({ effortLevels: ["medium"], defaultEffort: "medium" });
});

it("does not add Ultra to fallback models or a selector that does not advertise it", () => {
    for (const model of codexCliAgent.models) {
        expect(model.effortLevels).not.toContain("ultra");
        expect(model.effortLevels).toContain("max");
    }
    expect(
        codexCliAgent.modelsFromSelector([
            {
                value: "gpt-6-astra",
                name: "GPT-6 Astra",
                meta: { efforts: ["low", "max"], defaultEffort: "max" },
            },
        ])[0],
    ).toMatchObject({ effortLevels: ["low", "max"], defaultEffort: "max" });
});

it.each([claudeCodeAgent, opencodeAgent, acpGenericAgent("test")])(
    "does not newly advertise Ultra through the $type profile",
    (agent) => {
        expect(
            agent.modelsFromSelector([
                {
                    value: "example-model",
                    name: "Example model",
                    meta: { efforts: ["max", "ultra"], defaultEffort: "ultra" },
                },
            ])[0],
        ).toMatchObject({ effortLevels: ["max"], defaultEffort: "max" });
    },
);

it.each(["ultra", "max"] as const)("passes %s to Codex without changing its value", (effort) => {
    expect(codexCliAgent.profile.modelOptions?.("codex-cli/gpt-6-astra", effort)).toEqual([
        { configId: "model", value: "gpt-6-astra" },
        { configId: "reasoning_effort", value: effort },
    ]);
});
