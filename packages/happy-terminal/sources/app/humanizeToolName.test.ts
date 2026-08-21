import { describe, expect, it } from "vitest";

import { humanizeToolName } from "./humanizeToolName.js";

describe("humanizeToolName", () => {
    it("turns provider identifiers into readable English", () => {
        expect(humanizeToolName("apply_patch")).toBe("Apply patch");
        expect(humanizeToolName("write_stdin")).toBe("Write stdin");
        expect(humanizeToolName("custom-tool_name")).toBe("Custom tool name");
        expect(humanizeToolName("WebSearch")).toBe("Web search");
    });

    it("keeps curated and MCP labels descriptive", () => {
        expect(humanizeToolName("request_user_input")).toBe("Question");
        expect(humanizeToolName("spawn_agent")).toBe("Start subagent");
        expect(humanizeToolName("mcp__issue_tracker__create_ticket")).toBe(
            "Issue Tracker · Create Ticket",
        );
        expect(humanizeToolName("mcp__openaiDeveloper_docs__publishRelease")).toBe(
            "OpenAI Developer Docs · Publish Release",
        );
    });
});
