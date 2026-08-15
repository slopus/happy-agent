import { setTimeout as delay } from "node:timers/promises";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import type { ManagedSubagent, SubagentContext } from "../../agent/index.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { grokWaitSubagentsTool } from "./wait_subagents.js";

describe("wait_subagents", () => {
    it("uses the shared long polling contract and is steerable", () => {
        expect(grokWaitSubagentsTool.steerable).toBe(true);
        expect(
            Value.Check(grokWaitSubagentsTool.arguments, {
                mode: "wait_any",
                targets: ["agent-1"],
                timeout_ms: 3_600_000,
            }),
        ).toBe(true);
        expect(
            Value.Check(grokWaitSubagentsTool.arguments, {
                mode: "wait_any",
                targets: ["agent-1"],
                timeout_ms: 3_600_001,
            }),
        ).toBe(false);
    });

    it("waits for every specified subagent in wait_all mode", async () => {
        const harness = createJustBashToolHarness();
        let subagentCompleted = false;
        void delay(40).then(() => {
            subagentCompleted = true;
        });
        harness.context.subagents = subagentContext(() => subagentCompleted);

        const result = await grokWaitSubagentsTool.execute(
            {
                mode: "wait_all",
                targets: ["unguessable-agent-1"],
                timeout_ms: 500,
            },
            harness.context,
            { ctx: harness.ctx },
        );

        expect(result.results).toEqual([
            expect.objectContaining({
                agent_id: "unguessable-agent-1",
                path: "/root/test_subagent",
                status: "completed",
            }),
        ]);
    });
});

function subagentContext(completed: () => boolean): SubagentContext {
    const agent = (): ManagedSubagent => ({
        agentId: "unguessable-agent-1",
        description: "Test subagent",
        path: "/root/test_subagent",
        status: completed() ? "completed" : "running",
    });
    return {
        canSpawn: true,
        depth: 0,
        followUp: vi.fn(async () => agent()),
        interrupt: vi.fn(async () => agent()),
        list: vi.fn(() => [agent()]),
        maxDepth: 3,
        spawn: vi.fn(),
        wait: vi.fn(),
    };
}
