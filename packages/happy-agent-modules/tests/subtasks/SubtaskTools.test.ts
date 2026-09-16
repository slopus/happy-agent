import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import type { SubtasksModule } from "../../sources/subtasks/index.js";
import { archiveSubtaskTool } from "../../sources/subtasks/tools/archive_subtask.js";

describe("subtask archival tool", () => {
    it("reviews stopping work without elevating and captures the coordinator identity", async () => {
        const archive = vi.fn(async () => ({ agentId: "child" }));
        const tool = archiveSubtaskTool({ archive } as unknown as SubtasksModule, "parent");
        const ctx = createRootContext();
        const input = { agentId: "child" };
        expect(tool.durable).toBe(true);
        expect(tool.transactional).toBe(true);
        expect(tool.shouldReviewInAutoMode(input, ctx)).toBe(true);
        expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(tool.describeAutoPermissionAction!(input, ctx)).toContain('"child"');
        expect(tool.describeAutoPermissionAction!(input, ctx)).toContain("running descendants");
        await tool.execute(ctx, input, {} as never);
        expect(archive).toHaveBeenCalledWith(ctx, "parent", "child");
    });
});
