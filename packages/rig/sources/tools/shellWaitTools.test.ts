import { describe, expect, it } from "vitest";

import { claudeTaskInputTool } from "../agent/tools/claude/TaskInput.js";

describe("background task input", () => {
    it("allows steering to interrupt a background task wait", () => {
        expect(claudeTaskInputTool.steerable).toBe(true);
    });
});
