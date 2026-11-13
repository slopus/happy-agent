import type { AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/** One active bot and one ordinary root, held in memory. */
function fixture() {
    const ctx = moduleDatabase([], "subtask-conversations").context;
    const configs = new Map<string, AgentConfig>([
        ["botagent", { metadata: { version: 1 }, environment: { workingDirectory: "/bot" } }],
        ["plainroot", { metadata: { version: 1 } }],
    ] as [string, AgentConfig][]);
    const parents = new Map<string, string | null>([
        ["botagent", null],
        ["plainroot", null],
    ]);
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
        childOf: async (_ctx: Context, id: string) =>
            [...parents].flatMap(([child, parent]) => (parent === id ? [child] : [])),
        create: vi.fn(
            async (_ctx: Context, config: AgentConfig, options: { id: string; parent: string }) => {
                configs.set(options.id, config);
                parents.set(options.id, options.parent);
                return { id: options.id };
            },
        ),
    };
    const durableFunctions = { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() };
    const module = new SubtasksModule(
        {
            forAgent: async (_ctx: Context, id: string) =>
                id === "botagent" ? { status: "active" } : undefined,
        } as never,
        { forAgent: async () => undefined } as never,
        {
            unreportedAgentMetadata: () => ({ collaboration: { reportToCreator: false } }),
            selectModel: () => ({ model: "test-model", effort: "high", provider: "codex" }),
            selectAgentModel: () => ({ model: "test-model", effort: "high", provider: "codex" }),
        } as never,
        { onEventTransactional: vi.fn(), get: vi.fn() } as never,
        durableFunctions as never,
        {} as never,
        {} as never,
    );
    const hooks = module.beforeStart(ctx, agents as never);
    return { ctx, configs, parents, agents, module, hooks, durableFunctions };
}

const exportedBot = { kind: "telegram", botId: "botid", userId: 42, chatId: 42 };

describe("conversation subtasks", () => {
    it("creates an unreported shared-folder subtask with the caller's metadata and no opening task", async () => {
        const { ctx, configs, parents, module, durableFunctions } = fixture();
        await module.createConversation(
            ctx,
            "botagent",
            {
                title: "Ada on Telegram",
                metadata: { exportedBot, title: "ignored", subtask: false },
            },
            "conversation",
        );

        const config = configs.get("conversation")!;
        expect(parents.get("conversation")).toBe("botagent");
        expect(config.environment).toEqual({ workingDirectory: "/bot" });
        expect(config.metadata).toMatchObject({
            exportedBot,
            collaboration: { reportToCreator: false },
            title: "Ada on Telegram",
            subtask: true,
            subtaskConversation: true,
            version: 1,
        });
        expect(config.metadata?.["subtaskOrderKey"]).toEqual(expect.any(String));
        expect(module.isSubtask(config)).toBe(true);
        expect(durableFunctions.invoke).not.toHaveBeenCalled();
    });

    it("tells a conversation subtask it holds a conversation rather than reporting work", async () => {
        const { ctx, module, hooks } = fixture();
        await module.createConversation(
            ctx,
            "botagent",
            { title: "Ada on Telegram" },
            "conversation",
        );
        await module.create(
            ctx,
            "botagent",
            { title: "Patch login", text: "Fix it.", model: "test-model", effort: "high" },
            "delegated",
            undefined,
            { provider: "codex", model: undefined },
        );

        const conversation = await hooks.instructions!(ctx, {
            agent: { id: "conversation" },
        } as never);
        expect(conversation).toContain("holding one conversation for your parent");
        expect(conversation).not.toContain("receives only your final message");
        const delegated = await hooks.instructions!(ctx, { agent: { id: "delegated" } } as never);
        expect(delegated).toContain(
            "Your parent receives only your final message when you stop, so put your findings, diffs, verification, and anything still open there.",
        );
    });

    it("returns the same subtask when the same identity is created again", async () => {
        const { ctx, module, agents } = fixture();
        const input = { title: "Ada on Telegram", metadata: { exportedBot } };
        await module.createConversation(ctx, "botagent", input, "conversation");
        await expect(
            module.createConversation(ctx, "botagent", input, "conversation"),
        ).resolves.toEqual({ agentId: "conversation" });
        expect(agents.create).toHaveBeenCalledTimes(1);
    });

    it("refuses an identity that belongs elsewhere and a parent that cannot hold subtasks", async () => {
        const { ctx, module } = fixture();
        const input = { title: "Ada on Telegram" };
        await expect(
            module.createConversation(ctx, "botagent", input, "plainroot"),
        ).rejects.toThrow(SubtaskInputError);
        await expect(module.createConversation(ctx, "plainroot", input, "orphan")).rejects.toThrow(
            SubtaskInputError,
        );
        await expect(
            module.createConversation(ctx, "botagent", { title: "" }, "empty"),
        ).rejects.toThrow("The conversation subtask request is invalid.");
    });
});
