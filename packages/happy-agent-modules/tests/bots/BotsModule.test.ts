import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentConfig, AgentModuleScope, AgentSystemRef } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    botMigrations,
    BotConflictError,
    BotNotFoundError,
    BotsModule,
    type BotEvent,
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
    it("creates one durable folder/workspace/agent identity and derives collision-safe usernames", async () => {
        const fixture = await started("bots-create", false);
        try {
            const first = await fixture.bots.create(fixture.database.context, {
                id: "researchbot",
                name: "Research Assistant",
            });
            const second = await fixture.bots.create(fixture.database.context, {
                name: "Research Assistant",
            });

            expect(first).toMatchObject({
                id: "researchbot",
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

    it("gives a bot the roster its owner has, plus its own picture", async () => {
        const fixture = await started("bots-tools", true);
        try {
            const created = await fixture.bots.create(fixture.database.context, {
                name: "Toolbelt",
            });
            const roster = ["list_bots", "create_bot", "send_bot_message"];
            await expect(fixture.tools(created.agentId)).resolves.toEqual([
                ...roster,
                "set_bot_avatar",
            ]);
            // A person's own agent runs the roster but has no picture of its own to set.
            await expect(fixture.tools("someoneelsesagent")).resolves.toEqual(roster);
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
    return {
        agents,
        bots,
        database,
        events,
        tools: async (agentId: string): Promise<readonly string[]> => {
            const scope = { agent: { id: agentId } } as unknown as AgentModuleScope;
            const offered = await hooks.tools?.(database.context, scope);
            return (offered ?? []).map((tool) => tool.name);
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
