import { describe, expect, it } from "vitest";

import { defineTestModel as defineModel } from "../testing/defineTestModel.js";
import { formatSubagentToolCall } from "./formatSubagentToolCall.js";

const currentModel = defineModel({
    defaultThinkingLevel: "off",
    id: "openai/gpt-current",
    name: "GPT Current",
    thinkingLevels: ["off"],
});
const selectedModel = defineModel({
    defaultThinkingLevel: "off",
    id: "anthropic/sonnet-selected",
    name: "Sonnet Selected",
    thinkingLevels: ["off"],
});
const modelChoices = [
    { model: currentModel, providerId: "codex" },
    { model: selectedModel, providerId: "claude" },
];

describe("formatSubagentToolCall", () => {
    it("shows the friendly name of an explicitly selected model", () => {
        expect(
            formatSubagentToolCall({
                args: {
                    description: "Inspect the implementation",
                    model: selectedModel.id,
                    provider: "claude",
                },
                currentModel,
                currentProviderId: "codex",
                modelChoices,
                toolName: "Agent",
            }),
        ).toBe("Inspect the implementation · Sonnet Selected");
    });

    it("shows the inherited model for every provider's subagent call", () => {
        expect(
            [
                ["Agent", { description: "Inspect code" }],
                ["spawn_agent", { task_name: "inspect_code" }],
                ["spawn_subagent", { description: "Inspect code" }],
            ].map(([toolName, args]) =>
                formatSubagentToolCall({
                    args: args as Record<string, unknown>,
                    currentModel,
                    currentProviderId: "codex",
                    modelChoices,
                    toolName: toolName as string,
                }),
            ),
        ).toEqual([
            "Inspect code · GPT Current",
            "Inspect code · GPT Current",
            "Inspect code · GPT Current",
        ]);
    });

    it("prefers the recorded child model when rendering persisted calls", () => {
        expect(
            formatSubagentToolCall({
                args: { task_name: "historical_child" },
                currentModel,
                currentProviderId: "codex",
                modelChoices,
                resolvedModelId: selectedModel.id,
                toolName: "spawn_agent",
            }),
        ).toBe("Historical child · Sonnet Selected");
    });
});
