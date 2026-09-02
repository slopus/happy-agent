import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentConfig,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    botMigrations,
    BOTS_TABLE,
    BotConflictError,
    BotNotFoundError,
    BotsModule,
    type BotEvent,
    type BotRecord,
} from "../../sources/bots/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

class BotAgents {
    readonly configs = new Map<string, AgentConfig>();
    readonly aborted: string[] = [];

    async create(_ctx: Context, config: AgentConfig, options: { readonly id?: string } = {}) {
        const id = options.id ?? "generatedagent";
        if (this.configs.has(id)) throw new Error("Agent already exists.");
        this.configs.set(id, structuredClone(config));
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

    async childOf(): Promise<readonly string[]> {
        return [];
    }

    async parentOf(): Promise<null> {
        return null;
    }

    async abort(ctx: Context, agentId: string): Promise<void> {
        afterCommit(ctx, () => {
            this.aborted.push(agentId);
        });
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

describe("BotsModule", () => {
    it("migrates every existing bot to non-admin and non-system", async () => {
        const database = moduleDatabase(botMigrations.slice(0, 2), "bots-admin-migration");
        try {
            await database.ready;
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO ${sql.raw(BOTS_TABLE)} (
                    id, name, username, workspace_id, workspace_version, workspace_updated_at,
                    agent_id, path, status, avatar_source, avatar_thumbhash, order_key,
                    version, created_at, updated_at, archived_at
                ) VALUES (
                    'legacybot', 'Legacy Bot', 'legacy_bot', 'legacyworkspace', 1, 100,
                    'legacyagent', '/tmp/legacy-bot', 'active', NULL, NULL, '5',
                    1, 100, 100, NULL
                )`,
            );

            const migration = botMigrations[2]?.[1];
            if (migration === undefined) throw new Error("The bot admin migration is missing.");
            await migration(database.context, database.database);
            const systemMigration = botMigrations[3]?.[1];
            if (systemMigration === undefined)
                throw new Error("The system bot migration is missing.");
            await systemMigration(database.context, database.database);

            await expect(
                agentDatabaseRows<{
                    readonly is_admin: number;
                    readonly system_key: string | null;
                }>(
                    database.database,
                    sql`SELECT is_admin, system_key FROM ${sql.raw(BOTS_TABLE)}
                        WHERE id = 'legacybot'`,
                ),
            ).resolves.toEqual([{ is_admin: 0, system_key: null }]);
        } finally {
            database.close();
        }
    });

    it("seeds one marked Chief of Staff and never replaces it after archive or deletion", async () => {
        const fixture = await started("bots-chief-of-staff", true);
        try {
            await fixture.start();
            const [chief] = await fixture.bots.list(fixture.database.context);
            expect(chief).toMatchObject({
                avatar: {
                    kind: "image",
                    source: "generated",
                    thumbhash: expect.any(String),
                },
                isAdmin: true,
                name: "Chief of Staff",
                status: "active",
                systemKey: "chief_of_staff",
                username: "chief_of_staff",
                version: 1,
            });
            if (chief === undefined) throw new Error("The Chief of Staff bot was not seeded.");
            const avatar = await fixture.bots.avatar(fixture.database.context, chief.id);
            expect(avatar).toMatchObject({
                contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                thumbhash: chief.avatar?.thumbhash,
                height: 256,
                width: 256,
            });
            await expect(sharp(avatar?.bytes).metadata()).resolves.toMatchObject({
                format: "webp",
            });
            expect(fixture.events).toEqual([
                expect.objectContaining({
                    type: "bot_created",
                    bot: expect.objectContaining({ avatar: chief.avatar, version: 1 }),
                }),
            ]);
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "# Chief of Staff\n\nYou are the user's persistent chief of staff.",
            );

            const archived = await fixture.bots.archive(
                fixture.database.context,
                chief.id,
                chief.version,
            );
            await fixture.start();
            await expect(fixture.bots.list(fixture.database.context)).resolves.toEqual([archived]);

            await agentDatabaseRun(
                fixture.database.database,
                sql`DELETE FROM ${sql.raw(BOTS_TABLE)} WHERE id = ${chief.id}`,
            );
            await fixture.start();
            await expect(fixture.bots.list(fixture.database.context)).resolves.toEqual([]);
        } finally {
            await fixture.close();
        }
    });

    it("creates one durable folder/workspace/agent identity and derives collision-safe usernames", async () => {
        const fixture = await started("bots-create", false);
        try {
            const first = await fixture.bots.create(fixture.database.context, {
                id: "researchbot",
                isAdmin: false,
                name: "Research Assistant",
            });
            const second = await fixture.bots.create(fixture.database.context, {
                name: "Research Assistant",
            });

            expect(first).toMatchObject({
                id: "researchbot",
                isAdmin: false,
                name: "Research Assistant",
                username: "research_assistant",
                status: "active",
                version: 1,
                workspaceVersion: 1,
            });
            expect(second.username).toBe("research_assistant_2");
            expect(new Set([first.id, first.workspaceId, first.agentId]).size).toBe(3);
            await expect(stat(first.path)).resolves.toMatchObject({
                isDirectory: expect.any(Function),
            });
            expect((await stat(first.path)).isDirectory()).toBe(true);
            expect(fixture.agents.configs.get(first.agentId)).toMatchObject({
                environment: { workingDirectory: first.path },
                metadata: { title: "Research Assistant" },
                modules: { compute: { cwd: first.path } },
            });

            await expect(
                fixture.bots.create(fixture.database.context, {
                    id: first.id,
                    isAdmin: true,
                    name: "Ignored retry name",
                    username: "ignored_retry_name",
                }),
            ).resolves.toEqual(first);
            await expect(
                fixture.bots.create(fixture.database.context, {
                    name: "Username collision",
                    username: first.username,
                }),
            ).rejects.toBeInstanceOf(BotConflictError);
            await expect(
                fixture.bots.create(fixture.database.context, {
                    id: first.workspaceId,
                    name: "Workspace identity collision",
                }),
            ).rejects.toBeInstanceOf(BotConflictError);
            await expect(
                fixture.bots.create(fixture.database.context, {
                    id: first.agentId,
                    name: "Agent identity collision",
                }),
            ).rejects.toBeInstanceOf(BotConflictError);
            expect(fixture.events.filter((event) => event.type === "bot_created")).toHaveLength(2);
        } finally {
            await fixture.close();
        }
    });

    it("chains bot and workspace versions independently across reorder, rename, and archival", async () => {
        const fixture = await started("bots-lifecycle", true);
        try {
            const first = await fixture.bots.create(fixture.database.context, {
                name: "First Bot",
            });
            const second = await fixture.bots.create(fixture.database.context, {
                name: "Second Bot",
            });
            const reordered = await fixture.bots.reorder(
                fixture.database.context,
                first.id,
                second.id,
                first.version,
            );
            expect(reordered.version).toBe(first.version + 1);
            expect(reordered.workspaceVersion).toBe(first.workspaceVersion);

            const renamed = await fixture.bots.rename(
                fixture.database.context,
                first.id,
                "First Research Bot",
                reordered.version,
            );
            expect(renamed.username).toBe(first.username);
            expect(renamed.workspaceVersion).toBe(first.workspaceVersion);
            expect(fixture.agents.configs.get(first.agentId)?.metadata?.["title"]).toBe(
                "First Research Bot",
            );

            const unchanged = await fixture.bots.rename(
                fixture.database.context,
                first.id,
                "First Research Bot",
                renamed.version,
            );
            expect(unchanged).toEqual(renamed);

            const archived = await fixture.bots.archive(
                fixture.database.context,
                first.id,
                renamed.version,
            );
            expect(archived).toMatchObject({ status: "archived", archivedAt: expect.any(Number) });
            expect(archived.workspaceVersion).toBe(first.workspaceVersion + 1);
            expect(fixture.agents.aborted).toEqual([first.agentId]);
            expect(fixture.agents.configs.get(first.agentId)?.metadata?.["archivedAt"]).toEqual(
                expect.any(Number),
            );
            expect((await stat(first.path)).isDirectory()).toBe(true);

            await expect(
                fixture.bots.archive(fixture.database.context, first.id, archived.version),
            ).resolves.toEqual(archived);
            expect(fixture.agents.aborted).toEqual([first.agentId]);

            const restored = await fixture.bots.unarchive(
                fixture.database.context,
                first.id,
                archived.version,
            );
            expect(restored.status).toBe("active");
            expect(restored.archivedAt).toBeUndefined();
            expect(fixture.agents.configs.get(first.agentId)?.metadata?.["archivedAt"]).toBeNull();
            expect(fixture.events.at(-1)).toMatchObject({ type: "bot_updated", bot: restored });
        } finally {
            await fixture.close();
        }
    });

    it("normalizes, persists, versions, and clears avatar assets", async () => {
        const fixture = await started("bots-avatar", true);
        try {
            const created = await fixture.bots.create(fixture.database.context, {
                name: "Avatar Bot",
            });
            const updated = await fixture.bots.setAvatar(
                fixture.database.context,
                created.id,
                await png(40, 100, 220),
                "image/png",
                created.version,
            );
            expect(updated.avatar).toEqual({
                kind: "image",
                source: "user",
                thumbhash: expect.any(String),
            });
            expect(updated.workspaceVersion).toBe(created.workspaceVersion);
            const asset = await fixture.bots.avatar(fixture.database.context, created.id);
            // Whatever a bot is given, what the catalog stores is a WebP.
            expect(asset).toMatchObject({
                contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                etag: expect.stringMatching(/^"[a-f0-9]{64}"$/u),
                thumbhash: updated.avatar?.thumbhash,
            });
            await expect(sharp(asset?.bytes).metadata()).resolves.toMatchObject({ format: "webp" });

            await expect(
                fixture.bots.clearAvatar(fixture.database.context, created.id, created.version),
            ).rejects.toBeInstanceOf(BotConflictError);
            const cleared = await fixture.bots.clearAvatar(
                fixture.database.context,
                created.id,
                updated.version,
            );
            expect(cleared.avatar).toBeUndefined();
            await expect(
                fixture.bots.avatar(fixture.database.context, created.id),
            ).resolves.toBeUndefined();
            expect(fixture.events.filter((event) => event.type === "bot_updated")).toHaveLength(2);
        } finally {
            await fixture.close();
        }
    });

    it("lets a bot set its own avatar and refuses everyone else", async () => {
        const fixture = await started("bots-own-avatar", true);
        try {
            const created = await fixture.bots.create(fixture.database.context, {
                name: "Self Portrait",
            });
            const updated = await fixture.bots.setOwnAvatar(
                fixture.database.context,
                created.agentId,
                await png(10, 200, 90),
            );
            expect(updated.avatar).toEqual({
                kind: "image",
                source: "generated",
                thumbhash: expect.any(String),
            });
            expect(updated.version).toBe(created.version + 1);
            const asset = await fixture.bots.avatar(fixture.database.context, created.id);
            await expect(sharp(asset?.bytes).metadata()).resolves.toMatchObject({ format: "webp" });

            // Only the bot's own agent may set it, and an archived bot may not.
            await expect(
                fixture.bots.setOwnAvatar(
                    fixture.database.context,
                    "notabotagentid",
                    await png(1, 2, 3),
                ),
            ).rejects.toBeInstanceOf(BotNotFoundError);
            const archived = await fixture.bots.archive(
                fixture.database.context,
                created.id,
                updated.version,
            );
            await expect(
                fixture.bots.setOwnAvatar(
                    fixture.database.context,
                    archived.agentId,
                    await png(4, 5, 6),
                ),
            ).rejects.toBeInstanceOf(BotConflictError);
        } finally {
            await fixture.close();
        }
    });

    it("keeps creation visible but allows only people and admin bots to use it", async () => {
        const fixture = await started("bots-tools", true);
        try {
            const nonAdmin = await fixture.bots.create(fixture.database.context, {
                name: "Ordinary Toolbelt",
            });
            const roster = ["list_bots", "create_bot", "send_bot_message"];
            await expect(fixture.tools(nonAdmin.agentId)).resolves.toEqual([
                ...roster,
                "set_bot_avatar",
            ]);
            await expect(fixture.executeCreate(nonAdmin.agentId, "Denied Child")).rejects.toThrow(
                "Only an admin bot can create other bots. There are no admin bots on this installation.",
            );

            const admin = await fixture.bots.create(fixture.database.context, {
                isAdmin: true,
                name: "Admin Toolbelt",
            });
            await expect(
                fixture.executeCreate(nonAdmin.agentId, "Still Denied Child"),
            ).rejects.toThrow(
                `Only an admin bot can create other bots. Admin bots on this installation:\n- Admin Toolbelt — id ${admin.id}`,
            );
            await expect(fixture.tools(admin.agentId)).resolves.toEqual([
                ...roster,
                "set_bot_avatar",
            ]);
            await expect(
                fixture.executeCreate(admin.agentId, "Admin Child"),
            ).resolves.toMatchObject({
                isAdmin: false,
                name: "Admin Child",
            });
            // A person's own agent runs the roster but has no picture of its own to set.
            await expect(fixture.tools("someoneelsesagent")).resolves.toEqual(roster);
            await expect(
                fixture.executeCreate("someoneelsesagent", "Human Child"),
            ).resolves.toMatchObject({ isAdmin: false, name: "Human Child" });
        } finally {
            await fixture.close();
        }
    });

    it("contributes the bot's current identity only to its own agent instructions", async () => {
        const fixture = await started("bots-identity-instructions", true);
        try {
            const created = await fixture.bots.create(fixture.database.context, {
                id: "identitybot",
                name: "Research Assistant",
                username: "research_assistant",
            });

            await expect(fixture.instructions("someoneelsesagent")).resolves.toBe("");
            await expect(fixture.instructions(created.agentId)).resolves.toBe(
                [
                    "# Bot identity",
                    "",
                    'You are the persistent bot named "Research Assistant". Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.',
                    "- Bot ID: `identitybot`",
                    "- Username: `research_assistant`",
                ].join("\n"),
            );

            const renamed = await fixture.bots.rename(
                fixture.database.context,
                created.id,
                "Literature Scout",
                created.version,
            );
            expect(renamed.username).toBe("research_assistant");
            await expect(fixture.instructions(created.agentId)).resolves.toContain(
                'You are the persistent bot named "Literature Scout".',
            );
        } finally {
            await fixture.close();
        }
    });
});

async function started(name: string, workspacesEnabled: boolean) {
    const config = await temporaryTestConfig(
        `[features]\nworkspaces = ${workspacesEnabled ? "true" : "false"}\n`,
    );
    const database = moduleDatabase(botMigrations, name);
    await database.ready;
    const compute = new ComputeModule(config, new SecretsModule());
    const abort = new AbortModule(compute);
    const agents = new BotAgents();
    abort.beforeStart(database.context, agents.asRef());
    const bots = new BotsModule(config, abort);
    const hooks = bots.beforeStart(database.context, agents.asRef());
    const events: BotEvent[] = [];
    bots.onEvent((_ctx, event) => {
        events.push(event);
    });
    const toolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> => {
        const scope = { agent: { id: agentId } } as unknown as AgentModuleScope;
        return (await hooks.tools?.(database.context, scope)) ?? [];
    };
    return {
        agents,
        bots,
        database,
        events,
        start: async (): Promise<void> => {
            await hooks.afterStart?.(database.context, agents.asRef());
        },
        tools: async (agentId: string): Promise<readonly string[]> => {
            return (await toolsFor(agentId)).map((tool) => tool.name);
        },
        executeCreate: async (agentId: string, name: string): Promise<BotRecord> => {
            const tool = (await toolsFor(agentId)).find(
                (candidate) => candidate.name === "create_bot",
            );
            if (tool === undefined) throw new Error("The create_bot tool is missing.");
            return (await tool.execute(database.context, { name }, {
                id: `create-${name}`,
                kv: {
                    getOrCreate: async (
                        _ctx: Context,
                        _key: string,
                        create: () => unknown,
                    ): Promise<unknown> => await create(),
                },
                commit: async (_ctx: Context, result: unknown): Promise<unknown> => result,
            } as never)) as BotRecord;
        },
        instructions: async (agentId: string): Promise<string> => {
            const scope = { agent: { id: agentId } } as unknown as AgentModuleScope;
            return (await hooks.instructions?.(database.context, scope)) ?? "";
        },
        close: async () => {
            database.close();
            await rm(dirname(config.configuration.paths.publicHome), {
                force: true,
                recursive: true,
            });
        },
    };
}

async function png(red: number, green: number, blue: number): Promise<Buffer> {
    return await sharp({
        create: {
            background: { alpha: 0.75, b: blue, g: green, r: red },
            channels: 4,
            height: 80,
            width: 120,
        },
    })
        .png()
        .toBuffer();
}
