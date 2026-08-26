import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    botMigrations,
    BotConflictError,
    BotsModule,
    type BotEvent,
} from "../../sources/bots/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { projectsModuleFor } from "../support/projectsModule.js";
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
            expect(asset).toMatchObject({
                contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                contentType: "image/webp",
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
});

async function started(name: string, workspacesEnabled: boolean) {
    const config = await temporaryTestConfig(
        `[features]\nworkspaces = ${workspacesEnabled ? "true" : "false"}\n`,
    );
    const database = moduleDatabase(botMigrations, name);
    await database.ready;
    const compute = new ComputeModule(config);
    const abort = new AbortModule(compute);
    const agents = new BotAgents();
    abort.beforeStart(database.context, agents.asRef());
    const bots = new BotsModule(config, projectsModuleFor(config), abort);
    bots.beforeStart(database.context, agents.asRef());
    const events: BotEvent[] = [];
    bots.onEvent((_ctx, event) => {
        events.push(event);
    });
    return {
        agents,
        bots,
        database,
        events,
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
