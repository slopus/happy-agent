import type { AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    botSettingsMigrations,
    BotSettingsModule,
    DEFAULT_BOT_SETTINGS,
} from "../../sources/botSettings/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { SchedulingModule } from "../../sources/scheduling/SchedulingModule.js";
import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    advance,
    TestAgents,
    useSchedulingClock,
} from "../scheduling/support/schedulingHarness.js";
import { governedTree } from "./support.js";

const RESTRICTED = { ...DEFAULT_BOT_SETTINGS, crossWorkspace: false };

describe("bot settings reach", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("refuses a scheduled message outside the bot, when scheduled and again when due", async () => {
        useSchedulingClock();
        const botSettings = new BotSettingsModule();
        const module = new SchedulingModule(botSettings);
        const database = moduleDatabase(
            [...botSettingsMigrations, ...module.migrations],
            "bot-settings-scheduling",
        );
        await database.ready;
        const agents = new TestAgents({ botagent: null, childagent: "botagent", stranger: null });
        botSettings.beforeStart(database.context, agents.ref);
        await resolveModuleHooks(database.context, module, agents.ref);
        const ctx = database.context;
        try {
            // Promised while the bot still allowed reach beyond it.
            await module.schedule(ctx, "childagent", {
                id: "promisedearlier",
                targetAgentId: "stranger",
                message: "Status update",
                in: { minutes: 5 },
            });
            await botSettings.write(ctx, "botagent", RESTRICTED);

            await expect(
                module.schedule(ctx, "childagent", {
                    id: "promisedlater",
                    targetAgentId: "stranger",
                    message: "Another update",
                    in: { minutes: 1 },
                }),
            ).rejects.toThrow(
                "This bot's settings let its agents schedule messages only for the bot's own agents.",
            );
            await module.schedule(ctx, "childagent", {
                id: "insidebot",
                targetAgentId: "botagent",
                message: "Check in",
                in: { minutes: 5 },
            });

            await advance(5 * 60_000);
            expect(agents.delivered.map((message) => message.agentId)).toEqual(["botagent"]);
            await expect(
                module.getSchedule(ctx, "childagent", "promisedearlier"),
            ).resolves.toMatchObject({
                status: "undelivered",
                failure:
                    "This bot's settings let its agents schedule messages only for the bot's own agents.",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("lets a restricted bot's agents read only the history of the bot's own agents", async () => {
        const tree = await governedTree("bot-settings-history");
        try {
            const history = new HistoryModule(undefined, tree.botSettings);
            await tree.botSettings.write(tree.ctx, "botagent", RESTRICTED);
            await expect(
                history.resolveTarget(tree.ctx, "collaboratoragent", "botagent"),
            ).resolves.toBe("botagent");
            await expect(
                history.resolveTarget(tree.ctx, "collaboratoragent", "collaboratoragent"),
            ).resolves.toBe("collaboratoragent");
            await expect(
                history.resolveTarget(tree.ctx, "collaboratoragent", "otherchild"),
            ).rejects.toThrow(
                "This bot's settings let its agents read the history of only the bot's own agents.",
            );
            // An agent the bot does not govern reads as before.
            await expect(history.resolveTarget(tree.ctx, "otherchild", "botagent")).resolves.toBe(
                "botagent",
            );
        } finally {
            tree.close();
        }
    });

    it("keeps a restricted bot's subtasks in its own folder and governs its guest conversations", async () => {
        const tree = await governedTree("bot-settings-subtasks");
        try {
            const configs = new Map<string, AgentConfig>([
                ["botagent", { metadata: { version: 1 } } as AgentConfig],
            ]);
            const agents = {
                ...tree.agents,
                config: async (_ctx: Context, id: string) => configs.get(id),
                create: async (
                    _ctx: Context,
                    config: AgentConfig,
                    options: { id: string; parent: string },
                ) => {
                    configs.set(options.id, config);
                    tree.parents.set(options.id, options.parent);
                    return { id: options.id };
                },
            };
            const createWorkspace = vi.fn(async () => undefined);
            const module = new SubtasksModule(
                {
                    forAgent: async (_ctx: Context, id: string) =>
                        id === "botagent" ? { status: "active" } : undefined,
                } as never,
                { forAgent: async () => undefined } as never,
                {
                    unreportedAgentMetadata: () => ({ collaboration: { reportToCreator: false } }),
                    selectModel: () => ({ model: "test-model", effort: "high", provider: "codex" }),
                    selectAgentModel: () => ({
                        model: "test-model",
                        effort: "high",
                        provider: "codex",
                    }),
                } as never,
                { onEventTransactional: vi.fn(), get: vi.fn(), createWorkspace } as never,
                { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() } as never,
                {} as never,
                {} as never,
                tree.botSettings,
            );
            module.beforeStart(tree.ctx, agents as never);
            const task = {
                title: "Patch login",
                text: "Fix the redirect loop.",
                model: "test-model",
                effort: "high",
            } as const;
            const inWorkspace = {
                ...task,
                workspace: { projectId: "projectone", name: "Login fix" },
            };

            await tree.botSettings.write(tree.ctx, "botagent", RESTRICTED);
            await expect(
                module.create(tree.ctx, "botagent", inWorkspace, "workspacechild", "workspaceone", {
                    provider: "codex",
                    model: undefined,
                }),
            ).rejects.toThrow(SubtaskInputError);
            await expect(
                module.create(tree.ctx, "botagent", inWorkspace, "workspacechild", "workspaceone", {
                    provider: "codex",
                    model: undefined,
                }),
            ).rejects.toThrow("keep its subtasks in the bot's own folder");
            expect(createWorkspace).not.toHaveBeenCalled();
            // A subtask that shares the bot's folder is still the bot's own work.
            await module.create(tree.ctx, "botagent", task, "folderchild", undefined, {
                provider: "codex",
                model: undefined,
            });
            expect(tree.parents.get("folderchild")).toBe("botagent");
            // So is an exported bot's guest conversation, which the bot's settings then govern.
            await module.createConversation(
                tree.ctx,
                "botagent",
                {
                    title: "Ada on Telegram",
                    metadata: { exportedBot: { kind: "telegram", botId: "botid", userId: 42 } },
                },
                "guestconversation",
            );
            await expect(
                tree.botSettings.governing(tree.ctx, "guestconversation"),
            ).resolves.toEqual({ botAgentId: "botagent", settings: RESTRICTED });
            await expect(
                tree.botSettings.mayReach(tree.ctx, "guestconversation", "otherbotagent"),
            ).resolves.toBe(false);
            await expect(
                tree.botSettings.mayReach(tree.ctx, "guestconversation", "botagent"),
            ).resolves.toBe(true);

            // Without the restriction, the same request goes on to make the workspace.
            await tree.botSettings.write(tree.ctx, "botagent", DEFAULT_BOT_SETTINGS);
            await expect(
                module.create(tree.ctx, "botagent", inWorkspace, "workspacechild", "workspaceone", {
                    provider: "codex",
                    model: undefined,
                }),
            ).rejects.toThrow("The subtask's project was not found.");
            expect(createWorkspace).toHaveBeenCalledOnce();
        } finally {
            tree.close();
        }
    });
});
