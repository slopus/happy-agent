import { describe, expect, it } from "vitest";

import {
    assembleClaudeTools,
    claudeCollaborationTools,
    claudeTools,
} from "../../claude/assembleClaudeTools.js";

describe("assembleClaudeTools", () => {
    it("exposes Rig's curated native Claude tool surface from agent-owned definitions", () => {
        expect(claudeTools.map((tool) => tool.name)).toEqual([
            "TaskOutput",
            "TaskCreate",
            "TaskGet",
            "TaskUpdate",
            "TaskList",
            "TaskStop",
            "TaskInput",
            "AskUserQuestion",
        ]);
        expect(claudeCollaborationTools.map((tool) => tool.name)).toEqual([
            "Agent",
            "Workflow",
            "WaitForWorkflow",
            "SendMessage",
        ]);
        expect(assembleClaudeTools().map((tool) => tool.name)).toEqual([
            ...claudeTools.map((tool) => tool.name),
            ...claudeCollaborationTools.map((tool) => tool.name),
        ]);
        expect(assembleClaudeTools().every((tool) => tool.description.trim().length > 0)).toBe(
            true,
        );
    });

    it("keeps important Claude-native argument constraints on the provider-facing schemas", () => {
        const tools = new Map(assembleClaudeTools().map((tool) => [tool.name, tool]));
        expect(tools.get("AskUserQuestion")?.arguments).toMatchObject({
            additionalProperties: false,
            properties: { questions: { maxItems: 4, minItems: 1, type: "array" } },
            required: ["questions"],
        });
    });
});
