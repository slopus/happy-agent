import type { AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const input = {
    title: "Patch login",
    text: "Fix the redirect loop.",
    model: "test-model",
    effort: "high",
} as const;

/** Agents held in memory under one bot and one task, each an active subtask root. */
function fixture() {
    const ctx = moduleDatabase([], "subtask-roots").context;
    const configs = new Map<string, AgentConfig>([
        ["botagent", { metadata: { version: 1 } } as AgentConfig],
        ["taskagent", { metadata: { version: 1 } } as AgentConfig],
        ["plainroot", { metadata: { version: 1 } } as AgentConfig],
    ]);
    const parents = new Map<string, string | null>([
        ["botagent", null],
        ["taskagent", null],
        ["plainroot", null],
    ]);
    const taskStatus = { current: "active" as "active" | "archived" };
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
        childOf: async (_ctx: Context, id: string) =>
            [...parents].flatMap(([child, parent]) => (parent === id ? [child] : [])),
        create: async (
            _ctx: Context,
            config: AgentConfig,
            options: { id: string; parent: string },
        ) => {
            configs.set(options.id, config);
            parents.set(options.id, options.parent);
            return { id: options.id };
        },
        updateMetadata: async (_ctx: Context, id: string, update: Record<string, unknown>) => {
            const config = configs.get(id)!;
            configs.set(id, {
                ...config,
                metadata: { ...config.metadata, ...update },
            } as AgentConfig);
        },
    };
    const durableFunctions = { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() };
    const module = new SubtasksModule(
        {
            forAgent: async (_ctx: Context, id: string) =>
                id === "botagent" ? { status: "active" } : undefined,
        } as never,
        {
            forAgent: async (_ctx: Context, id: string) =>
                id === "taskagent" ? { status: taskStatus.current } : undefined,
        } as never,
        {
            selectModel: () => ({ model: "test-model", effort: "high", provider: "codex" }),
        } as never,
        { onEventTransactional: vi.fn(), get: vi.fn() } as never,
        durableFunctions as never,
        {} as never,
        {} as never,
    );
    const hooks = module.beforeStart(ctx, agents as never);
    return { ctx, configs, parents, module, hooks, durableFunctions, taskStatus };
}

describe("subtask roots", () => {
    it("lets a task create subtasks two levels deep, like a bot", async () => {
        const { ctx, module, parents, configs, durableFunctions } = fixture();
        await module.create(ctx, "taskagent", input, "first", undefined, "codex");
        await module.create(ctx, "first", input, "second", undefined, "codex");
        expect(parents.get("first")).toBe("taskagent");
        expect(parents.get("second")).toBe("first");
        expect(module.isSubtask(configs.get("first"))).toBe(true);
        expect(durableFunctions.invoke).toHaveBeenCalledTimes(2);
        await expect(
            module.create(ctx, "second", input, "third", undefined, "codex"),
        ).rejects.toThrow("Subtasks are limited to two levels below a bot or a task.");

        await module.create(ctx, "botagent", input, "botchild", undefined, "codex");
        expect(parents.get("botchild")).toBe("botagent");
    });

    it("refuses ordinary roots and archived tasks", async () => {
        const { ctx, module, taskStatus, configs } = fixture();
        await expect(
            module.create(ctx, "plainroot", input, "orphan", undefined, "codex"),
        ).rejects.toThrow(SubtaskInputError);
        taskStatus.current = "archived";
        await expect(
            module.create(ctx, "taskagent", input, "late", undefined, "codex"),
        ).rejects.toThrow("Only a bot, a task, or another subtask can create a subtask.");
        configs.set("taskagent", { metadata: { version: 2, archivedAt: 1 } } as AgentConfig);
        await expect(
            module.create(ctx, "taskagent", input, "later", undefined, "codex"),
        ).rejects.toThrow("An archived agent cannot create subtasks.");
    });

    it("lets a task archive its direct subtask and guides it as a coordinator", async () => {
        const { ctx, module, hooks, configs } = fixture();
        await module.create(ctx, "taskagent", input, "child", undefined, "codex");
        await expect(module.archive(ctx, "plainroot", "child")).rejects.toThrow(
            "Only a subtask's direct coordinating bot, task, or subtask may archive it.",
        );
        await module.archive(ctx, "taskagent", "child");
        expect(configs.get("child")?.metadata?.["archivedAt"]).toEqual(expect.any(Number));

        const guidance = await hooks.instructions!(ctx, { agent: { id: "taskagent" } } as never);
        expect(guidance).toContain("Only bots, tasks, and subtasks create them");
        expect(guidance).toContain("at most two levels below a bot or task");
        await expect(
            hooks.instructions!(ctx, { agent: { id: "plainroot" } } as never),
        ).resolves.toBe("");
    });
});
