import { describe, expect, it } from "vitest";

import type { SubagentSummary } from "../protocol/index.js";
import { sortSubagentsForDisplay } from "./sortSubagentsForDisplay.js";

describe("sortSubagentsForDisplay", () => {
    it("stably places active and suspended work before terminal work", () => {
        const completed = subagent("completed", "completed");
        const waiting = subagent("waiting", "queued");
        const failed = subagent("failed", "error");
        const running = subagent("running", "running");
        const suspended = subagent("suspended", "suspended");

        expect(
            sortSubagentsForDisplay([completed, waiting, failed, running, suspended]).map(
                (agent) => agent.id,
            ),
        ).toEqual(["waiting", "running", "suspended", "completed", "failed"]);
    });
});

function subagent(id: string, status: SubagentSummary["status"]): SubagentSummary {
    return {
        agentId: id,
        createdAt: 0,
        depth: 1,
        description: id,
        id,
        modelId: "openai/test",
        parentSessionId: "root",
        status,
        updatedAt: 0,
    };
}
