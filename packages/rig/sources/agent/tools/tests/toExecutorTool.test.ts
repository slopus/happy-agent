import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { defineTool } from "../../types.js";
import { toExecutorTool } from "../toExecutorTool.js";

describe("toExecutorTool", () => {
    it("converts the Rig schema without dropping execution metadata from the Rig definition", () => {
        const tool = defineTool({
            name: "example_lookup",
            label: "Example lookup",
            description: "Look up one value.",
            deferLoading: true,
            arguments: Type.Object(
                { path: Type.String({ description: "Path to read." }) },
                { additionalProperties: false },
            ),
            returnType: Type.Object({ text: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async ({ path }) => ({ text: path }),
            toLLM: ({ text }) => [{ type: "text", text }],
            toUI: ({ text }) => text,
            locks: [],
        });

        expect(toExecutorTool(tool)).toEqual({
            name: "example_lookup",
            description: "Look up one value.",
            parameters: tool.arguments,
            deferLoading: true,
        });
        expect(tool.execute).toBeTypeOf("function");
        expect(tool.shouldReviewInAutoMode).toBeTypeOf("function");
    });

    it("passes an exact provider-facing definition through unchanged", () => {
        const executorTool = {
            kind: "custom" as const,
            name: "custom_payload",
            description: "Accept a custom payload.",
            format: {
                type: "grammar" as const,
                syntax: "lark" as const,
                definition: "start: PATCH",
            },
        };
        const tool = defineTool({
            name: "custom_payload",
            label: "Custom payload",
            description: "Accept a custom payload.",
            executorTool,
            arguments: Type.Object({ patch: Type.String() }),
            returnType: Type.Object({ text: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ text: "done" }),
            toLLM: ({ text }) => [{ type: "text", text }],
            toUI: ({ text }) => text,
            locks: [],
        });

        expect(toExecutorTool(tool)).toBe(executorTool);
    });

    it("explains steerability in an exact provider-facing definition", () => {
        const executorTool = {
            kind: "custom" as const,
            name: "wait",
            description: "Wait for an update.",
        };
        const tool = defineTool({
            name: "wait",
            label: "Wait",
            description: "Wait for an update.",
            executorTool,
            arguments: Type.Object({}),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            steerable: true,
            execute: async () => ({}),
            toLLM: () => [],
            toUI: () => "Finished waiting.",
            locks: [],
        });

        expect(toExecutorTool(tool)).toEqual({
            ...executorTool,
            description:
                "Wait for an update.\n\nThis tool is steerable: Rig interrupts it when new steering arrives so the agent can respond immediately.",
        });
        expect(executorTool).not.toHaveProperty("steerable");
        expect(executorTool.description).toBe("Wait for an update.");
    });
});
