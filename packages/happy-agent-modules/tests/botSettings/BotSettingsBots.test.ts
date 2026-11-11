import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
    AgentConfig,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    botSettingsMigrations,
    BotSettingsModule,
    DEFAULT_BOT_SETTINGS,
    type BotSettings,
} from "../../sources/botSettings/index.js";
import { botMigrations, BotConflictError, BotsModule } from "../../sources/bots/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { CollaborationModule } from "../../sources/collaboration/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { taskMigrations, TasksModule } from "../../sources/tasks/index.js";
import { TitlesModule } from "../../sources/titles/index.js";
import { workspaceMigrations, WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { providersOf, sharedKV } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const LOCKED: BotSettings = {
    allowedSecretIds: ["deploy-token"],
    crossWorkspace: false,
    compute: { type: "docker", image: "node:22" },
};

/** An agent collection that keeps configurations and ancestry in memory. */
class Agents {
    readonly models = [];
    readonly configs = new Map<string, AgentConfig>();
    readonly parents = new Map<string, string | null>();

    async create(
        _ctx: Context,
        config: AgentConfig,
        options: { readonly id?: string; readonly parent?: string | null } = {},
    ) {
        const id = options.id ?? "generatedagent";
        if (this.configs.has(id)) throw new Error("Agent already exists.");
        this.configs.set(id, structuredClone(config));
        this.parents.set(id, options.parent ?? null);
        return { id };
    }

    async config(_ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return structuredClone(this.configs.get(agentId));
    }

    async updateMetadata(
        _ctx: Context,
        agentId: string,
        update: NonNullable<AgentConfig["metadata"]>,
    ): Promise<void> {
        const config = this.configs.get(agentId);
        if (config === undefined) throw new Error("Agent missing.");
        this.configs.set(agentId, {
            ...config,
            metadata: { ...config.metadata, ...structuredClone(update) },
        });
    }

    async send(): Promise<{ readonly id: string }> {
        return { id: "message" };
    }

    async childOf(_ctx: Context, agentId: string): Promise<readonly string[]> {
        return [...this.parents].flatMap(([child, parent]) => (parent === agentId ? [child] : []));
    }

    async parentOf(_ctx: Context, agentId: string): Promise<string | null> {
        return this.parents.get(agentId) ?? null;
    }

    async abort(ctx: Context): Promise<void> {
        afterCommit(ctx, () => undefined);
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

/** The catalogs a bot's settings gate, built the way the composition root builds them. */
async function started(name: string) {
    const provider = new ScriptedProvider([]);
    const config = await temporaryTestConfig("[features]\nworkspaces = true\n", {
        inference: {
            providers: providersOf(provider),
            models: [
                {
                    providerId: "scripted",
                    id: "anthropic/sonnet-5",
                    name: "Sonnet",
                    effortLevels: ["off"],
                    defaultEffort: "off",
                },
            ],
        },
    });
    const database = moduleDatabase(
        [
            ...botSettingsMigrations,
            ...projectMigrations,
            ...workspaceMigrations,
            ...botMigrations,
            ...taskMigrations,
        ],
        name,
    );
    await database.ready;
    const ctx = database.context;
    const agents = new Agents();
    const botSettings = new BotSettingsModule();
    botSettings.beforeStart(ctx, agents.asRef());
    const compute = new ComputeModule(
        config,
        new SecretsModule(botSettings),
        undefined,
        botSettings,
    );
    const abort = new AbortModule(compute);
    abort.beforeStart(ctx, agents.asRef());
    const git = new GitModule();
    const durableFunctions = new DurableFunctionsModule();
    const runners = new RunnersModule(config);
    const projects = new ProjectsModule(config, git, abort, durableFunctions, runners, botSettings);
    const workspaces = new WorkspacesModule(
        config,
        projects,
        git,
        abort,
        durableFunctions,
        runners,
        botSettings,
    );
    const titles = new TitlesModule(config, new HistoryModule(), workspaces);
    const collaboration = new CollaborationModule(config, abort, new HistoryModule(), compute);
    const tasks = new TasksModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        compute,
        {
            register: vi.fn(),
            invoke: vi.fn(),
            cancel: vi.fn(),
        } as unknown as DurableFunctionsModule,
        collaboration,
        botSettings,
    );
    const bots = new BotsModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        tasks,
        new DurableFunctionsModule(),
        botSettings,
    );
    const hooks: Record<string, AgentModuleHooks> = {
        collaboration: collaboration.beforeStart(ctx, agents.asRef()),
        projects: projects.beforeStart(ctx, agents.asRef()),
        workspaces: workspaces.beforeStart(ctx, agents.asRef()),
        tasks: tasks.beforeStart(ctx, agents.asRef()),
        bots: await bots.beforeStart(ctx, agents.asRef()),
    };
    const scope = (agentId: string) =>
        ({ agent: { id: agentId, provider: "scripted" }, kv: sharedKV() }) as AgentModuleScope;
    const toolNames = async (module: string, agentId: string): Promise<readonly string[]> =>
        ((await hooks[module]!.tools?.(ctx, scope(agentId))) ?? []).map((tool) => tool.name);
    const tool = async (agentId: string, toolName: string): Promise<AnyAgentTool> => {
        const found = ((await hooks.bots!.tools?.(ctx, scope(agentId))) ?? []).find(
            (candidate) => candidate.name === toolName,
        );
        if (found === undefined) throw new Error(`The ${toolName} tool is missing.`);
        return found;
    };
    return {
        agents,
        botSettings,
        bots,
        ctx,
        hooks,
        scope,
        tasks,
        tool,
        toolNames,
        close: async () => {
            await bots.close();
            await titles.close();
            database.close();
            await rm(dirname(config.configuration.paths.publicHome), {
                force: true,
                recursive: true,
            });
        },
    };
}

describe("bot settings through the bots catalog", () => {
    it("gives only active admin bots the settings tools, and enforces that in the catalog", async () => {
        const fixture = await started("bot-settings-admin-only");
        try {
            const { bots, ctx } = fixture;
            const admin = await bots.create(ctx, { name: "Admin", isAdmin: true });
            const worker = await bots.create(ctx, { name: "Worker" });

            expect(await fixture.toolNames("bots", admin.agentId)).toEqual(
                expect.arrayContaining(["get_bot_settings", "update_bot_settings"]),
            );
            expect(await fixture.toolNames("bots", worker.agentId)).not.toContain(
                "update_bot_settings",
            );
            expect(await fixture.toolNames("bots", worker.agentId)).not.toContain(
                "get_bot_settings",
            );

            // The catalog refuses a bot that is not an admin, whatever tool surface it has.
            await expect(bots.settingsForAgent(ctx, worker.agentId, worker.id)).rejects.toThrow(
                "Only an active admin bot can read bot settings.",
            );
            await expect(
                bots.updateSettingsForAgent(ctx, worker.agentId, worker.id, DEFAULT_BOT_SETTINGS, {
                    crossWorkspace: true,
                }),
            ).rejects.toThrow("Only an active admin bot can change bot settings.");
            await expect(bots.settings(ctx, worker.id)).resolves.toEqual(DEFAULT_BOT_SETTINGS);
        } finally {
            await fixture.close();
        }
    });

    it("reviews a change that widens access and describes exactly what widens", async () => {
        const fixture = await started("bot-settings-tool-permissions");
        try {
            const { bots, ctx } = fixture;
            const admin = await bots.create(ctx, { name: "Admin", isAdmin: true });
            const worker = await bots.create(ctx, { name: "Worker" });
            const get = await fixture.tool(admin.agentId, "get_bot_settings");
            const update = await fixture.tool(admin.agentId, "update_bot_settings");

            expect(get.shouldReviewInAutoMode({ botId: worker.id }, ctx)).toBe(false);
            expect(get.requiresAutoOrFullAccess).toBeUndefined();
            // A settings change reaches agents outside this workspace, so no restricted mode runs it.
            expect(update.requiresAutoOrFullAccess).toBe(true);

            const narrowing = { botId: worker.id, previous: DEFAULT_BOT_SETTINGS, ...LOCKED };
            expect(update.shouldReviewInAutoMode(narrowing, ctx)).toBe(false);
            expect(update.describeAutoPermissionAction?.(narrowing, ctx)).toBe(
                `narrowing the settings of bot ${JSON.stringify(worker.id)}`,
            );

            const widening = {
                botId: worker.id,
                previous: LOCKED,
                allowedSecretIds: ["deploy-token", "github"],
                crossWorkspace: true,
            };
            expect(update.shouldReviewInAutoMode(widening, ctx)).toBe(true);
            expect(update.describeAutoPermissionAction?.(widening, ctx)).toBe(
                `widening the settings of bot ${JSON.stringify(worker.id)}, which governs the bot's agent and every agent working under it: allowing the secret "github"; restoring reach to other projects, workspaces, tasks, bots, and agents outside the bot`,
            );
            const toHost = { botId: worker.id, previous: LOCKED, compute: { type: "host" } };
            expect(update.shouldReviewInAutoMode(toHost, ctx)).toBe(true);
            expect(update.describeAutoPermissionAction?.(toHost, ctx)).toContain(
                'moving the bot\'s commands out of the Docker image "node:22" onto the host machine',
            );
        } finally {
            await fixture.close();
        }
    });

    it("applies a change only while previous is still what is stored", async () => {
        const fixture = await started("bot-settings-previous");
        try {
            const { bots, ctx } = fixture;
            const admin = await bots.create(ctx, { name: "Admin", isAdmin: true });
            const worker = await bots.create(ctx, { name: "Worker" });
            const get = await fixture.tool(admin.agentId, "get_bot_settings");
            const update = await fixture.tool(admin.agentId, "update_bot_settings");

            const read = (await get.execute(
                ctx,
                { botId: worker.id } as never,
                undefined as never,
            )) as {
                settings: BotSettings;
            };
            expect(read.settings).toEqual(DEFAULT_BOT_SETTINGS);
            expect(get.toLLM(read as never)).toEqual([
                expect.objectContaining({
                    text: expect.stringContaining(
                        `Current value, to pass as previous: ${JSON.stringify(DEFAULT_BOT_SETTINGS)}`,
                    ),
                }),
            ]);

            const applied = (await update.execute(
                ctx,
                { botId: worker.id, previous: read.settings, crossWorkspace: false } as never,
                undefined as never,
            )) as { changed: boolean; settings: BotSettings };
            expect(applied).toMatchObject({
                changed: true,
                settings: { ...DEFAULT_BOT_SETTINGS, crossWorkspace: false },
            });
            // A decision made from stale settings is refused, not merged over the newer ones.
            await expect(
                update.execute(
                    ctx,
                    { botId: worker.id, previous: read.settings, allowedSecretIds: [] } as never,
                    undefined as never,
                ),
            ).rejects.toThrow(BotConflictError);
            await expect(
                update.execute(
                    ctx,
                    { botId: worker.id, previous: applied.settings } as never,
                    undefined as never,
                ),
            ).rejects.toThrow("Name at least one setting to change");
            await expect(bots.settings(ctx, worker.id)).resolves.toEqual({
                ...DEFAULT_BOT_SETTINGS,
                crossWorkspace: false,
            });
            // The owner's direct path merges a patch into whatever is stored.
            await expect(
                bots.updateSettings(ctx, worker.id, { allowedSecretIds: [] }),
            ).resolves.toMatchObject({
                changed: true,
                settings: { allowedSecretIds: [], crossWorkspace: false },
            });
        } finally {
            await fixture.close();
        }
    });

    it("takes projects, workspaces, tasks, and other bots away from a bot that restricts reach", async () => {
        const fixture = await started("bot-settings-catalog-reach");
        try {
            const { bots, ctx } = fixture;
            const worker = await bots.create(ctx, { name: "Worker" });
            const peer = await bots.create(ctx, { name: "Peer" });
            // A task the bot opened before it was restricted.
            const errand = await fixture.tasks.create(ctx, {
                name: "Errand",
                creatorAgentId: worker.agentId,
            });

            for (const agentId of [worker.agentId, errand.agentId]) {
                expect(await fixture.toolNames("projects", agentId)).toContain("list_projects");
                expect(await fixture.toolNames("workspaces", agentId)).toContain("list_workspaces");
            }
            expect(await fixture.toolNames("tasks", worker.agentId)).toContain("create_task");
            expect(await fixture.toolNames("bots", worker.agentId)).toEqual(
                expect.arrayContaining([
                    "list_bots",
                    "send_bot_message",
                    "set_bot_avatar",
                    "set_bot_name",
                ]),
            );

            await bots.updateSettings(ctx, worker.id, { crossWorkspace: false });

            // The task stays with the bot that opened it.
            await expect(fixture.botSettings.governing(ctx, errand.agentId)).resolves.toMatchObject(
                {
                    botAgentId: worker.agentId,
                },
            );
            for (const agentId of [worker.agentId, errand.agentId]) {
                expect(await fixture.toolNames("projects", agentId)).toEqual([]);
                expect(await fixture.toolNames("workspaces", agentId)).toEqual([]);
                expect(await fixture.toolNames("tasks", agentId)).toEqual([]);
            }
            expect(await fixture.toolNames("bots", worker.agentId)).toEqual([
                "set_bot_avatar",
                "set_bot_name",
            ]);
            expect(await fixture.toolNames("bots", errand.agentId)).toEqual([]);
            await expect(
                fixture.hooks.bots!.instructions?.(ctx, fixture.scope(worker.agentId)),
            ).resolves.not.toContain("When you mention a bot");
            await expect(
                bots.sendMessage(ctx, worker.agentId, peer.id, "Hello.", "outsidemessage"),
            ).rejects.toThrow("let its agents reach only the bot's own agents, not other bots");

            // A bot nobody restricted keeps everything.
            expect(await fixture.toolNames("projects", peer.agentId)).toContain("list_projects");
            expect(await fixture.toolNames("bots", peer.agentId)).toContain("send_bot_message");
        } finally {
            await fixture.close();
        }
    });
});
