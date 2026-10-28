import { rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentBaseAcceptedMessage,
    type AgentConfig,
    type AgentKV,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { listBotsTool } from "../../sources/bots/tools/list_bots.js";
import { setBotAvatarTool } from "../../sources/bots/tools/set_bot_avatar.js";
import { setBotNameTool } from "../../sources/bots/tools/set_bot_name.js";
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
import { CollaborationModule } from "../../sources/collaboration/index.js";
import {
    DurableFunctionsModule,
    durableFunctionsMigrations,
} from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { taskMigrations, TasksModule } from "../../sources/tasks/index.js";
import { TitlesModule } from "../../sources/titles/index.js";
import { WorkspacesModule } from "../../sources/workspaces/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { providersOf, sharedKV, textTurn } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsCatalogFor } from "../support/projectsModule.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";

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

const BOT_REFERENCE_INSTRUCTIONS =
    'When you mention a bot in a reply, write <happy-agent id="…"/> with the bot\'s agent ID, not its bot ID; people see its live name as a link. The bot tools give you the exact tag.';

describe("BotsModule", () => {
    it.each(["Release Steward", "New Bot"])(
        "keeps a manual rename to %s when inference finishes later",
        async (name) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const fixture = await started("bots-rename-race", false, [
                async function* () {
                    await gate;
                    yield* textTurn("<title>Scout</title>");
                },
            ]);
            try {
                const bot = await fixture.bots.create(fixture.database.context, {});
                await fixture.accept(bot.agentId, "user", "Find useful research papers.");
                // Acceptance returns while the independent naming request is still waiting.
                await vi.waitFor(() =>
                    expect(fixture.provider.sessions[0]?.requests).toHaveLength(1),
                );
                await fixture.bots.rename(fixture.database.context, bot.id, name, bot.version);
                release();
                await fixture.namingFinished();
                expect(await fixture.bots.get(fixture.database.context, bot.id)).toMatchObject({
                    name,
                    nameConfigured: true,
                    version: 2,
                });
                expect(fixture.agents.configs.get(bot.agentId)?.metadata?.title).toBe(name);
            } finally {
                release();
                await fixture.close();
            }
        },
    );

    it("names an unnamed bot from only its first text-bearing user message", async () => {
        const fixture = await started("bots-first-message", false, [
            textTurn("<title>Scout</title>"),
        ]);
        try {
            const bot = await fixture.bots.create(fixture.database.context, {});
            expect(bot).toMatchObject({ name: "New Bot", username: "bot", nameConfigured: false });
            expect((await stat(bot.path)).isDirectory()).toBe(true);
            expect(fixture.agents.configs.get(bot.agentId)?.metadata?.title).toBe("New Bot");
            await fixture.accept(bot.agentId, "system", "Internal wake-up");
            await fixture.accept(bot.agentId, "agent", "Peer request");
            await fixture.accept(bot.agentId, "user", "   ");
            expect(fixture.provider.sessions).toHaveLength(0);
            await fixture.accept(bot.agentId, "user", "Find useful research papers for me.");
            await fixture.accept(bot.agentId, "user", "Now inspect releases instead.");
            await fixture.namingFinished();
            expect(await fixture.bots.get(fixture.database.context, bot.id)).toMatchObject({
                name: "Scout",
                nameConfigured: true,
                version: 2,
                id: bot.id,
                agentId: bot.agentId,
                workspaceId: bot.workspaceId,
                username: bot.username,
                path: bot.path,
            });
            expect(fixture.provider.sessions).toHaveLength(1);
            expect(JSON.stringify(fixture.provider.sessions[0]?.requests)).toContain(
                "research papers",
            );
            expect(JSON.stringify(fixture.provider.sessions[0]?.requests)).not.toContain(
                "inspect releases",
            );
            expect(fixture.agents.configs.get(bot.agentId)?.metadata?.title).toBe("Scout");
            expect(fixture.events).toContainEqual(
                expect.objectContaining({
                    type: "bot_updated",
                    bot: expect.objectContaining({ name: "Scout" }),
                }),
            );
        } finally {
            await fixture.close();
        }
    });

    it("keeps the placeholder without retrying after an empty inference result", async () => {
        const fixture = await started("bots-empty-name", false, [textTurn("")]);
        try {
            const bot = await fixture.bots.create(fixture.database.context, {});
            await fixture.accept(bot.agentId, "user", "Find papers.");
            await fixture.namingFinished();
            await fixture.accept(bot.agentId, "user", "Try naming again.");
            expect(fixture.provider.sessions).toHaveLength(1);
            expect(await fixture.bots.get(fixture.database.context, bot.id)).toMatchObject({
                name: "New Bot",
                nameConfigured: false,
                version: 1,
            });
        } finally {
            await fixture.close();
        }
    });

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
            const namingMigration = botMigrations[4]?.[1];
            if (namingMigration === undefined) throw new Error("The naming migration is missing.");
            await namingMigration(database.context, database.database);

            await expect(
                agentDatabaseRows<{
                    readonly is_admin: number;
                    readonly system_key: string | null;
                    readonly name_configured: number;
                }>(
                    database.database,
                    sql`SELECT is_admin, system_key, name_configured FROM ${sql.raw(BOTS_TABLE)}
                        WHERE id = 'legacybot'`,
                ),
            ).resolves.toEqual([{ is_admin: 0, system_key: null, name_configured: 1 }]);
        } finally {
            database.close();
        }
    });

    it("seeds one marked Happy bot and never replaces it after archive or deletion", async () => {
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
                name: "Happy",
                status: "active",
                systemKey: "chief_of_staff",
                username: "happy",
                version: 1,
            });
            if (chief === undefined) throw new Error("The Happy bot was not seeded.");
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
                "# Happy\n\nYou are Happy, the user's main agent.",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "the user asks you.",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Before planning or carrying out a task, check the recipe documents in docs/recipe for relevant guidance.",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Resolve recipe/ beside the Happy Agent documentation README path supplied in your environment, not relative to your bot workspace",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Read every relevant recipe in full",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Execute relevant recipes automatically by default within the user's authorized task.",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Use create_project to register an existing local folder",
            );
            await expect(fixture.instructions(chief.agentId)).resolves.toContain(
                "Use clone_project for GitHub repositories (owner/name) or other HTTPS Git remotes",
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

    it("renames a Chief of Staff seeded by an earlier release to Happy once, keeping its identity", async () => {
        const fixture = await started("bots-happy-rename", true);
        try {
            await fixture.start();
            const [seeded] = await fixture.bots.list(fixture.database.context);
            if (seeded === undefined) throw new Error("The Happy bot was not seeded.");
            // An earlier release seeded the same bot under its old name and knew no renames.
            await agentDatabaseRun(
                fixture.database.database,
                sql`UPDATE ${sql.raw(BOTS_TABLE)} SET name = 'Chief of Staff' WHERE id = ${seeded.id}`,
            );
            await agentDatabaseRun(
                fixture.database.database,
                sql`DELETE FROM happy_agent_module_bot_system_renames`,
            );

            await fixture.start();
            const [renamed] = await fixture.bots.list(fixture.database.context);
            expect(renamed).toMatchObject({
                id: seeded.id,
                agentId: seeded.agentId,
                name: "Happy",
                systemKey: "chief_of_staff",
                username: seeded.username,
            });

            // A person who names it "Chief of Staff" again keeps that name across restarts.
            const chosen = await fixture.bots.rename(
                fixture.database.context,
                seeded.id,
                "Chief of Staff",
                renamed!.version,
            );
            await fixture.start();
            await expect(fixture.bots.list(fixture.database.context)).resolves.toEqual([chosen]);
        } finally {
            await fixture.close();
        }
    });

    it("leaves a renamed earlier Chief of Staff with the name its person chose", async () => {
        const fixture = await started("bots-happy-rename-chosen", true);
        try {
            await fixture.start();
            const [seeded] = await fixture.bots.list(fixture.database.context);
            if (seeded === undefined) throw new Error("The Happy bot was not seeded.");
            await agentDatabaseRun(
                fixture.database.database,
                sql`UPDATE ${sql.raw(BOTS_TABLE)} SET name = 'Release coordinator' WHERE id = ${seeded.id}`,
            );
            await agentDatabaseRun(
                fixture.database.database,
                sql`DELETE FROM happy_agent_module_bot_system_renames`,
            );
            await fixture.start();
            const [kept] = await fixture.bots.list(fixture.database.context);
            expect(kept).toMatchObject({ id: seeded.id, name: "Release coordinator" });
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
            const updated = await fixture.bots.setAvatarForAgent(
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
                fixture.bots.setAvatarForAgent(
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
                fixture.bots.setAvatarForAgent(
                    fixture.database.context,
                    archived.agentId,
                    await png(4, 5, 6),
                ),
            ).rejects.toBeInstanceOf(BotConflictError);
        } finally {
            await fixture.close();
        }
    });

    it("lets admins set any bot's avatar while keeping ordinary bots self-only", async () => {
        const fixture = await started("bots-admin-avatar", true);
        const ctx = fixture.database.context;
        try {
            const admin = await fixture.bots.create(ctx, { name: "Admin", isAdmin: true });
            const ordinary = await fixture.bots.create(ctx, { name: "Ordinary" });
            const target = await fixture.bots.create(ctx, { name: "Target" });
            const bytes = await png(10, 20, 30);
            await writeFile(join(admin.path, "picture.png"), bytes);
            await writeFile(join(ordinary.path, "picture.png"), bytes);
            const adminTool = setBotAvatarTool(fixture.bots, admin.agentId);
            const ordinaryTool = setBotAvatarTool(fixture.bots, ordinary.agentId);
            expect(
                adminTool.shouldReviewInAutoMode({ path: "picture.png", botId: target.id }, ctx),
            ).toBe(false);
            expect(adminTool.shouldRunInFullAccessInAutoMode).toBeUndefined();
            await expect(
                ordinaryTool.execute(ctx, { path: "missing.png", botId: target.id }, {} as never),
            ).rejects.toThrow("Only an admin bot can set another bot's avatar.");
            await expect(
                fixture.bots.setAvatarForAgent(ctx, ordinary.agentId, bytes, target.id),
            ).rejects.toThrow("Only an admin bot can set another bot's avatar.");
            expect((await fixture.bots.get(ctx, target.id))?.avatar).toBeUndefined();
            await ordinaryTool.execute(
                ctx,
                { path: "picture.png", botId: ordinary.id },
                {} as never,
            );
            expect((await fixture.bots.get(ctx, ordinary.id))?.avatar?.source).toBe("generated");

            await adminTool.execute(ctx, { path: "picture.png", botId: target.id }, {} as never);
            const updated = await fixture.bots.get(ctx, target.id);
            expect(updated).toMatchObject({
                version: target.version + 1,
                avatar: { source: "generated" },
            });
            expect((await fixture.bots.get(ctx, admin.id))?.avatar).toBeUndefined();
            const archived = await fixture.bots.archive(ctx, target.id, updated!.version);
            await adminTool.execute(ctx, { path: "picture.png", botId: target.id }, {} as never);
            expect(await fixture.bots.get(ctx, target.id)).toMatchObject({
                status: "archived",
                version: archived.version + 1,
            });
            await expect(
                adminTool.execute(ctx, { path: "picture.png", botId: "missingbot" }, {} as never),
            ).rejects.toBeInstanceOf(BotNotFoundError);
            await fixture.bots.archive(ctx, admin.id, admin.version);
            await expect(
                adminTool.execute(ctx, { path: "picture.png", botId: target.id }, {} as never),
            ).rejects.toThrow("An archived bot cannot change avatars.");
            await expect(
                fixture.bots.setAvatarForAgent(ctx, admin.agentId, bytes, target.id),
            ).rejects.toBeInstanceOf(BotConflictError);
        } finally {
            await fixture.close();
        }
    });

    it("targets the calling bot unless an admin names another, and explains a refusal", async () => {
        const fixture = await started("bots-avatar-target", true);
        const ctx = fixture.database.context;
        try {
            const admin = await fixture.bots.create(ctx, { name: "Chief", isAdmin: true });
            const ordinary = await fixture.bots.create(ctx, { name: "Scout" });
            const peer = await fixture.bots.create(ctx, { name: "Peer" });
            await writeFile(join(admin.path, "picture.png"), await png(10, 20, 30));
            await writeFile(join(ordinary.path, "picture.png"), await png(40, 50, 60));
            const adminTool = setBotAvatarTool(fixture.bots, admin.agentId);
            const ordinaryTool = setBotAvatarTool(fixture.bots, ordinary.agentId);

            // Omitted, the tool sets the caller's own picture and nobody else's.
            await ordinaryTool.execute(ctx, { path: "picture.png" }, {} as never);
            const own = await fixture.bots.get(ctx, ordinary.id);
            expect(own).toMatchObject({ version: ordinary.version + 1, avatar: { kind: "image" } });
            expect((await fixture.bots.get(ctx, peer.id))?.avatar).toBeUndefined();
            expect((await fixture.bots.get(ctx, admin.id))?.avatar).toBeUndefined();

            // A bot that is not an admin may name only itself; the refusal says who can.
            const refused = ordinaryTool.execute(
                ctx,
                { path: "picture.png", botId: peer.id },
                {} as never,
            );
            await expect(refused).rejects.toThrow(
                [
                    "Only an admin bot can set another bot's avatar. Omit botId, or pass your own bot ID, to set your own picture. Admin bots on this installation:",
                    `- Chief — id ${admin.id}`,
                ].join("\n"),
            );
            expect(await fixture.bots.get(ctx, peer.id)).toEqual(peer);
            expect(await fixture.bots.get(ctx, ordinary.id)).toEqual(own);

            // An admin sets another bot's picture with the same event and version as the API.
            const before = fixture.events.length;
            await adminTool.execute(ctx, { path: "picture.png", botId: peer.id }, {} as never);
            const updated = await fixture.bots.get(ctx, peer.id);
            expect(updated).toMatchObject({ version: peer.version + 1, avatar: { kind: "image" } });
            expect(fixture.events.slice(before)).toEqual([
                expect.objectContaining({ type: "bot_updated", bot: updated }),
            ]);

            // An ID naming no bot is explained, and nothing is written.
            await expect(
                adminTool.execute(ctx, { path: "picture.png", botId: "nosuchbot" }, {} as never),
            ).rejects.toThrow("There is no bot with ID nosuchbot. Find bot IDs with list_bots.");
            expect(fixture.events).toHaveLength(before + 1);
        } finally {
            await fixture.close();
        }
    });

    it("renames the calling bot unless an admin names another, exactly as the rename route", async () => {
        const fixture = await started("bots-set-name", true);
        const ctx = fixture.database.context;
        try {
            const admin = await fixture.bots.create(ctx, { name: "Chief", isAdmin: true });
            const ordinary = await fixture.bots.create(ctx, { name: "Scout" });
            // Unnamed, so it would still take its name from its first message.
            const peer = await fixture.bots.create(ctx, {});
            expect(peer.nameConfigured).toBe(false);
            const adminTool = setBotNameTool(fixture.bots, admin.agentId);
            const ordinaryTool = setBotNameTool(fixture.bots, ordinary.agentId);
            expect(adminTool.shouldReviewInAutoMode({ name: "X", botId: peer.id }, ctx)).toBe(
                false,
            );
            expect(adminTool.shouldRunInFullAccessInAutoMode).toBeUndefined();

            // Omitted, the tool renames the caller and nobody else.
            const renamed = await ordinaryTool.execute(ctx, { name: "Scout Two" }, {} as never);
            expect(renamed).toMatchObject({
                id: ordinary.id,
                name: "Scout Two",
                username: ordinary.username,
                version: ordinary.version + 1,
            });
            expect(fixture.agents.configs.get(ordinary.agentId)?.metadata?.title).toBe("Scout Two");
            expect(await fixture.bots.get(ctx, peer.id)).toEqual(peer);
            expect(await fixture.bots.get(ctx, admin.id)).toEqual(admin);

            // Naming itself by ID is the same as omitting it.
            const self = await ordinaryTool.execute(
                ctx,
                { name: "Scout Three", botId: ordinary.id },
                {} as never,
            );
            expect(self).toMatchObject({ name: "Scout Three", version: ordinary.version + 2 });

            // A bot that is not an admin may not rename another; the refusal says who can.
            await expect(
                ordinaryTool.execute(ctx, { name: "Hijacked", botId: peer.id }, {} as never),
            ).rejects.toThrow(
                [
                    "Only an admin bot can rename another bot. Omit botId, or pass your own bot ID, to rename yourself. Admin bots on this installation:",
                    `- Chief — id ${admin.id}`,
                ].join("\n"),
            );
            await expect(
                fixture.bots.renameForAgent(ctx, ordinary.agentId, "Hijacked", peer.id),
            ).rejects.toThrow("Only an admin bot can rename another bot.");
            expect(await fixture.bots.get(ctx, peer.id)).toEqual(peer);

            // An admin renames another bot as PATCH /v0/bots/:botId does.
            const before = fixture.events.length;
            const named = await adminTool.execute(
                ctx,
                { name: "Telegram Scout", botId: peer.id },
                {} as never,
            );
            expect(named).toMatchObject({
                id: peer.id,
                name: "Telegram Scout",
                nameConfigured: true,
                username: peer.username,
                version: peer.version + 1,
            });
            expect(await fixture.bots.get(ctx, peer.id)).toEqual(named);
            expect(fixture.events.slice(before)).toEqual([
                expect.objectContaining({ type: "bot_updated", bot: named, previousBot: peer }),
            ]);
            expect(fixture.agents.configs.get(peer.agentId)?.metadata?.title).toBe(
                "Telegram Scout",
            );
            expect(adminTool.toLLM(named)).toEqual([
                {
                    type: "text",
                    text: `The bot is now named "Telegram Scout" (id ${peer.id}, username ${peer.username}).`,
                },
            ]);

            // An ID naming no bot, and a name the route would refuse, change nothing.
            await expect(
                adminTool.execute(ctx, { name: "Ghost", botId: "nosuchbot" }, {} as never),
            ).rejects.toThrow("There is no bot with ID nosuchbot. Find bot IDs with list_bots.");
            for (const name of ["", "   ", "Tab\tName", "x".repeat(257)]) {
                await expect(
                    fixture.bots.renameForAgent(ctx, admin.agentId, name, peer.id),
                ).rejects.toThrow("A bot name must be 1 to 256 characters");
            }
            expect(fixture.events).toHaveLength(before + 1);
            expect(await fixture.bots.get(ctx, peer.id)).toEqual(named);
        } finally {
            await fixture.close();
        }
    });

    it("keeps admin avatar images inside the acting bot's folder", async () => {
        const fixture = await started("bots-avatar-paths", true);
        const ctx = fixture.database.context;
        try {
            const admin = await fixture.bots.create(ctx, { name: "Admin", isAdmin: true });
            const target = await fixture.bots.create(ctx, { name: "Target" });
            const outside = join(target.path, "picture.png");
            await writeFile(outside, await png(10, 20, 30));
            await symlink(outside, join(admin.path, "escape.png"));
            const tool = setBotAvatarTool(fixture.bots, admin.agentId);
            for (const path of [outside, "escape.png", "../target/picture.png"]) {
                await expect(
                    tool.execute(ctx, { path, botId: target.id }, {} as never),
                ).rejects.toThrow("The avatar image must live inside your own folder.");
            }
            expect((await fixture.bots.get(ctx, target.id))?.avatar).toBeUndefined();
        } finally {
            await fixture.close();
        }
    });

    it("shows and filters avatar presence, including archived bots", async () => {
        const fixture = await started("bots-avatar-list", true);
        const ctx = fixture.database.context;
        try {
            const missing = await fixture.bots.create(ctx, { name: "Missing" });
            const pictured = await fixture.bots.create(ctx, { name: "Pictured" });
            await fixture.bots.setAvatarForAgent(ctx, pictured.agentId, await png(10, 20, 30));
            await fixture.bots.archive(ctx, missing.id, missing.version);
            const tool = listBotsTool(fixture.bots);
            const all = await tool.execute(ctx, {}, {} as never);
            expect(all.bots.map((bot) => bot.id)).toEqual([missing.id, pictured.id]);
            expect(tool.toLLM(all)).toEqual([
                { type: "text", text: expect.stringContaining("no avatar") },
            ]);
            expect(tool.toLLM(all)).toEqual([
                { type: "text", text: expect.stringContaining("has avatar") },
            ]);
            expect(tool.toLLM(all)).toEqual([
                {
                    type: "text",
                    text: expect.stringContaining(
                        `mention it as <happy-agent id="${pictured.agentId}"/>`,
                    ),
                },
            ]);
            expect(
                (await tool.execute(ctx, { hasAvatar: false }, {} as never)).bots.map(
                    (bot) => bot.id,
                ),
            ).toEqual([missing.id]);
            expect(
                (await tool.execute(ctx, { hasAvatar: true }, {} as never)).bots.map(
                    (bot) => bot.id,
                ),
            ).toEqual([pictured.id]);
            expect(tool.toLLM({ bots: [] })).toEqual([{ type: "text", text: "No bots found." }]);
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
                "set_bot_name",
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
                "set_bot_name",
            ]);
            await expect(
                fixture.executeCreate(admin.agentId, "Admin Child"),
            ).resolves.toMatchObject({
                isAdmin: false,
                name: "Admin Child",
            });
            // A person's own agent runs the roster but has no picture of its own to set.
            await expect(fixture.tools("someoneelsesagent")).resolves.toEqual(roster);
            const child = await fixture.executeCreate("someoneelsesagent", "Human Child");
            expect(child).toMatchObject({ isAdmin: false, name: "Human Child" });
            const create = (await fixture.toolsFor("someoneelsesagent")).find(
                (candidate) => candidate.name === "create_bot",
            );
            expect(create?.toLLM(child)).toEqual([
                {
                    type: "text",
                    text: expect.stringContaining(
                        `Mention it in chat as <happy-agent id="${child.agentId}"/>.`,
                    ),
                },
            ]);
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

            // Every agent offered the bot tools learns how to mention a bot, and nothing else.
            await expect(fixture.instructions("someoneelsesagent")).resolves.toBe(
                BOT_REFERENCE_INSTRUCTIONS,
            );
            await expect(fixture.instructions(created.agentId)).resolves.toBe(
                [
                    "# Bot identity",
                    "",
                    'You are the persistent bot named "Research Assistant". Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.',
                    "- Bot ID: `identitybot`",
                    "- Username: `research_assistant`",
                    "",
                    "Strongly prefer doing repository work in workspace-bound subtasks, even for small repository tasks. Use create_subtask to create a subtask in the relevant project, with its own project workspace, instead of doing that work in the bot's folder or merely changing directories into a repository.",
                    "",
                    'When the user asks to "work in a project", this means creating a subtask in that project. Strongly prefer this project-bound subtask workflow by default; a shared-filesystem subtask in the bot\'s folder does not put the work in the project. Reuse an existing suitable workspace-bound subtask for follow-up work.',
                    "",
                    "Keep delegated work in its subtask. Use send_agent_message to ask the subtask agent for progress, findings, diffs, verification, or follow-up changes. Do not directly inspect or modify its files, run commands in its workspace, or take over its work. Direct access to another workspace often requires elevated permissions and review by the reviewer model; talking to the subtask agent keeps the work in its own workspace and avoids unnecessary permission reviews.",
                    "",
                    'When the user says "make a task" or "create a task", use create_task. A task is a persistent, user-visible conversation with its own folder, owned by the person who asked; it has no avatar and creates its own subtasks for project work. Give it a short name, put the work in its opening text, and follow up with send_task_message and list_tasks. Use create_subtask only when the user asks for a subtask or the work is a delegated part of your own conversation.',
                    "",
                    "For other work, prefer create_subtask for substantial, distinct workstreams; handle small steps inline. Usually create second-level subtasks only on explicit user request. If the user explicitly asks for a subtask, use create_subtask. Use create_agent for internal research. Coordinate via send_agent_message and archive_subtask; do not wait for subtasks.",
                    "",
                    BOT_REFERENCE_INSTRUCTIONS,
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

it("leaves a previously attempted unnamed bot alone", async () => {
    const fixture = await started("bots-old-name-attempt", true);
    try {
        const bot = await fixture.bots.create(fixture.database.context, {});
        await fixture.markNamingAttempted(bot.agentId);
        await fixture.accept(bot.agentId, "user", "A new follow-up message.");
        expect(fixture.provider.sessions).toHaveLength(0);
        expect((await fixture.bots.get(fixture.database.context, bot.id))?.name).toBe("New Bot");
    } finally {
        await fixture.close();
    }
});

async function started(name: string, workspacesEnabled: boolean, script: ScriptedTurn[] = []) {
    const provider = new ScriptedProvider(script);
    const config = await temporaryTestConfig(
        `[features]\nworkspaces = ${workspacesEnabled ? "true" : "false"}\n`,
        {
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
        },
    );
    const database = moduleDatabase(
        [
            ...projectMigrations,
            ...workspaceMigrations,
            ...botMigrations,
            ...taskMigrations,
            ...durableFunctionsMigrations,
        ],
        name,
    );
    await database.ready;
    const compute = new ComputeModule(config, new SecretsModule());
    const abort = new AbortModule(compute);
    const agents = new BotAgents();
    abort.beforeStart(database.context, agents.asRef());
    const git = new GitModule();
    const { projects, runners } = projectsCatalogFor(config, git);
    const workspaces = new WorkspacesModule(
        config,
        projects,
        git,
        abort,
        new DurableFunctionsModule(),
        runners,
    );
    const titles = new TitlesModule(config, new HistoryModule(), workspaces);
    const naming = vi.spyOn(titles, "suggestBotName");
    const collaboration = new CollaborationModule(config, abort, new HistoryModule(), compute);
    const tasks = new TasksModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        compute,
        new DurableFunctionsModule(),
        collaboration,
    );
    tasks.beforeStart(database.context, agents.asRef());
    const durable = new DurableFunctionsModule();
    const durableHooks = durable.beforeStart(database.context);
    const bots = new BotsModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        tasks,
        durable,
    );
    const hooks = await bots.beforeStart(database.context, agents.asRef());
    await durableHooks.afterStart?.(database.context, agents.asRef());
    const events: BotEvent[] = [];
    const agentKVs = new Map<string, AgentKV>();
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
        tasks,
        database,
        events,
        provider,
        markNamingAttempted: async (agentId: string) => {
            const kv = agentKVs.get(agentId) ?? sharedKV();
            agentKVs.set(agentId, kv);
            await kv.write(database.context, "bot-name-attempted", { at: 1 });
        },
        accept: async (
            agentId: string,
            role: AgentBaseAcceptedMessage["message"]["role"],
            text: string,
        ): Promise<void> => {
            const kv = agentKVs.get(agentId) ?? sharedKV();
            agentKVs.set(agentId, kv);
            const scope = { agent: { id: agentId, provider: "scripted" }, kv } as AgentModuleScope;
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact?.(ctx, scope, {
                    id: `message-${text}`,
                    kind: "send",
                    profile: null,
                    message:
                        role === "agent"
                            ? {
                                  role,
                                  author: { id: "peeragent", description: "A peer bot" },
                                  content: [{ type: "text", text }],
                              }
                            : { role, content: [{ type: "text", text }] },
                });
            });
        },
        namingFinished: async (): Promise<void> => {
            await vi.waitFor(() => expect(naming).toHaveBeenCalled());
            await Promise.allSettled(
                naming.mock.results.flatMap((result) =>
                    result.type === "return" ? [result.value] : [],
                ),
            );
            // The database fixture resolves queries on the microtask queue. Drain
            // that queue after inference so assertions observe the final transaction.
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        start: async (): Promise<void> => {
            await hooks.afterStart?.(database.context, agents.asRef());
        },
        toolsFor,
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
            durable.stop();
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
