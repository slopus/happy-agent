import { describe, expect, it } from "vitest";

import {
    assembleClaudeTools,
    claudeCollaborationTools,
    claudeTools,
} from "../../claude/assembleClaudeTools.js";

describe("Claude tool parity", () => {
    it("assembles the complete curated Claude coding and collaboration surface", () => {
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
        expect(assembleClaudeTools()).toEqual([...claudeTools, ...claudeCollaborationTools]);
    });

    it("keeps deliberate product non-goals out of the Claude tool surface", () => {
        const names = assembleClaudeTools().map((tool) => tool.name);

        expect(names).not.toEqual(
            expect.arrayContaining(["EnterPlanMode", "ExitPlanMode", "NotebookEdit", "Skill"]),
        );
    });
});
