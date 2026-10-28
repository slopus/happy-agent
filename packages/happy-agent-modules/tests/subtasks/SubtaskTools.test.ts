import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtasksModule } from "../../sources/subtasks/index.js";
import { archiveSubtaskTool } from "../../sources/subtasks/tools/archive_subtask.js";
import { createSubtaskTool } from "../../sources/subtasks/tools/create_subtask.js";

describe("subtask creation tool", () => {
    const tool = createSubtaskTool(
        {} as unknown as SubtasksModule,
        "parent",
        { provider: "codex", model: undefined },
        "auto",
        "OPTIONS-LISTING",
    );

    it("guides the model toward sidebar-friendly titles", () => {
        expect(tool.description).toContain("2–3 words");
        expect(tool.description).toContain("4 at most, as a last resort");
        expect(tool.description).toContain("Put details in text.");
    });

    it("reserves subtasks for substantial workstreams and discourages unrequested nesting", () => {
        expect(tool.description).toContain("substantial, distinct workstreams");
        expect(tool.description).toContain("changes across projects");
        expect(tool.description).toContain("small steps inline");
        expect(tool.description).toContain(
            "Usually create second-level subtasks only on explicit user request.",
        );
    });

    it("keeps the word count as guidance rather than validation", () => {
        expect(tool.parameters).toBeDefined();
        expect(
            Value.Check(tool.parameters!, {
                title: "Investigate the intermittent login redirect failure",
                text: "Find what causes the redirect failure.",
                model: "test-model",
                effort: "high",
            }),
        ).toBe(true);
    });
});

describe("subtask instructions", () => {
    it.each([false, true])(
        "guides substantial, shallow delegation for subtask=%s",
        async (subtask) => {
            const module = new SubtasksModule(
                { forAgent: async () => ({}) } as never,
                {} as never,
                {} as never,
                { onEventTransactional: vi.fn() } as never,
                { register: vi.fn() } as never,
                {} as never,
                {} as never,
            );
            const ctx = createRootContext();
            const hooks = module.beforeStart(ctx, {
                config: async () => ({ metadata: { subtask } }),
            } as never);
            const instructions = await hooks.instructions!(ctx, {
                agent: { id: "agent" },
            } as never);
            expect(instructions).toContain("substantial, distinct workstreams");
            expect(instructions).toContain("changes across projects");
            expect(instructions).toContain("small steps inline");
            expect(instructions).toContain(
                "Usually create second-level subtasks only on explicit user request.",
            );
            expect(instructions).toContain(
                'When you mention a subtask in a reply, write <happy-agent id="…"/> with its agent ID',
            );
        },
    );
});

describe("subtask creation result", () => {
    it("gives the coordinator the exact tag to mention the new subtask", () => {
        const tool = createSubtaskTool(
            {} as unknown as SubtasksModule,
            "parent",
            { provider: "codex", model: undefined },
            "auto",
            "OPTIONS-LISTING",
        );
        expect(tool.toLLM({ agentId: "subtaskagent1" })).toEqual([
            {
                type: "text",
                text: 'Created subtask subtaskagent1 sharing your filesystem. It runs independently; use send_agent_message to coordinate with it. Mention it in chat as <happy-agent id="subtaskagent1"/>.',
            },
        ]);
    });
});

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
