import { mkdir, stat } from "node:fs/promises";

import { createId } from "@paralleldrive/cuid2";
import {
    currentAgentEnvironment,
    type AgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import { ConfigModule } from "../config/index.js";
import { senderAgentIdMetadata } from "../impl/messageOrigin.js";

import {
    botRecordSchema,
    createBotInputSchema,
    BotConflictError,
    BotNotFoundError,
    type BotAvatarAsset,
    type BotRecord,
    type CreateBotInput,
} from "./Bot.js";
import { normalizeBotAvatar } from "./impl/normalizeBotAvatar.js";
import {
    botEventSchema,
    type BotEvent,
    type BotEventListener,
    type BotUnsubscribe,
} from "./BotEvent.js";
import { botMigrations } from "./BotMigrations.js";
import {
    deleteBotAvatar,
    insertBot,
    readBot,
    readBotAvatar,
    readBotByAgent,
    readBotByUsername,
    readBotByWorkspace,
    readBots,
    updateBot,
    writeBotAvatar,
} from "./BotStore.js";
import { formatBotIdentityPrompt } from "./impl/formatBotIdentityPrompt.js";
import { createBotTool } from "./tools/create_bot.js";
import { listBotsTool } from "./tools/list_bots.js";
import { sendBotMessageTool } from "./tools/send_bot_message.js";
import { setBotAvatarTool } from "./tools/set_bot_avatar.js";

/** Persistent single-conversation assistants and the dedicated folders they own. */
export class BotsModule implements AgentModule {
    readonly name = "bots";
    readonly migrations = botMigrations;

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #listeners = new Set<BotEventListener>();
    #agents: AgentSystemRef | undefined;

    constructor(config: ConfigModule, abort: AbortModule) {
        this.#config = config;
        this.#abort = abort;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const bot = await readBotByAgent(ctx, scope.agent.id);
            return bot === undefined ? "" : formatBotIdentityPrompt(bot);
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const roster = [
                listBotsTool(this),
                createBotTool(this),
                sendBotMessageTool(this, scope.agent.id),
            ];
            // A bot is a peer of every other bot, and additionally manages its own picture.
            if ((await readBotByAgent(ctx, scope.agent.id)) !== undefined) {
                return [...roster, setBotAvatarTool(this, scope.agent.id)];
            }
            // Bots belong to the conversation a person is having. A subagent is one pair of
            // hands inside the task it was given and does not manage the bot roster.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return [];
            return roster;
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    onEvent(listener: BotEventListener): BotUnsubscribe {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async list(ctx: Context): Promise<readonly BotRecord[]> {
        return structuredClone(await readBots(ctx));
    }

    async get(ctx: Context, botId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBot(ctx, botId));
    }

    async forWorkspace(ctx: Context, workspaceId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBotByWorkspace(ctx, workspaceId));
    }

    async forAgent(ctx: Context, agentId: string): Promise<BotRecord | undefined> {
        return structuredClone(await readBotByAgent(ctx, agentId));
    }

    /**
     * Create the row, its folder, and its ordinary root agent in one database transaction.
     *
     * Every read that justifies the write happens inside that transaction, so the identities and
     * the username it settles on cannot go stale before the insert. The folder is made last:
     * a name the database refuses aborts the transaction before anything reaches the disk.
     */
    async create(ctx: Context, input: CreateBotInput): Promise<BotRecord> {
        if (!Value.Check(createBotInputSchema, input)) {
            throw new Error("Bot creation input is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            if (input.id !== undefined) {
                const existing = await readBot(txCtx, input.id);
                if (existing !== undefined) return existing;
            }
            const agents = this.#requireAgents();
            const botId = input.id ?? (await this.#unusedIdentity(txCtx, new Set()));
            if (
                (await readBotByWorkspace(txCtx, botId)) !== undefined ||
                (await readBotByAgent(txCtx, botId)) !== undefined ||
                (await agents.config(txCtx, botId)) !== undefined
            ) {
                throw new BotConflictError("The requested bot ID is already in use.");
            }
            const username = await this.#chooseUsername(txCtx, input.name, input.username);
            const path = this.#config.botPath(username);
            const workspaceId = await this.#unusedIdentity(txCtx, new Set([botId]));
            const agentId = await this.#unusedIdentity(txCtx, new Set([botId, workspaceId]));
            const now = Date.now();
            const config: AgentConfig = {
                provenance: { createdAt: now },
                environment: {
                    ...currentAgentEnvironment(),
                    workingDirectory: path,
                },
                // A bot's conversation is the bot. It is called what the bot is called
                // from birth, which also settles the title and keeps automatic naming
                // from writing one over it.
                metadata: { title: input.name, updatedAt: now, version: 1 },
                modules: {
                    compute: {
                        cwd: path,
                        secretScope: { workspaceId },
                    },
                },
            };
            const agent = await agents.create(txCtx, config, { id: agentId, parent: null });
            const ordered = await readBots(txCtx);
            const bot: BotRecord = {
                id: botId,
                name: input.name,
                username,
                workspaceId,
                workspaceVersion: 1,
                workspaceUpdatedAt: now,
                agentId: agent.id,
                path,
                status: "active",
                orderKey: orderKeyBetween(ordered.at(-1)?.orderKey ?? null, null),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            await insertBot(txCtx, bot);
            // The unique username, path, workspace, and agent columns have all accepted this bot
            // by now, so the folder is the last thing that can fail. An existing directory is the
            // folder of a creation that was rolled back after making it, and is taken up again.
            const existingFolder = await stat(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
            });
            if (existingFolder !== undefined && !existingFolder.isDirectory()) {
                throw new BotConflictError("The bot folder path is already in use.");
            }
            await mkdir(path, { recursive: true, mode: 0o755 });
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "bot_created",
                bot,
            });
            return structuredClone(bot);
        });
    }

    /**
     * Deliver one message into the bot's conversation. The message queues behind the bot's
     * current run and starts one immediately when the bot is idle. The caller-supplied message
     * ID makes redelivery after an interruption idempotent.
     */
    async sendMessage(
        ctx: Context,
        fromAgentId: string,
        botId: string,
        text: string,
        messageId: string,
    ): Promise<BotRecord> {
        const bot = await this.#required(ctx, botId);
        if (bot.status === "archived") {
            throw new BotConflictError("The bot is archived and cannot receive messages.");
        }
        if (bot.agentId === fromAgentId) {
            throw new BotConflictError("A bot cannot send a message to itself.");
        }
        const agents = this.#requireAgents();
        const accepted = await agents.send(
            ctx,
            bot.agentId,
            {
                role: "agent",
                author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                content: [{ type: "text", text: `Message from agent ${fromAgentId}:\n\n${text}` }],
            },
            {
                id: messageId,
                metadata: {
                    bots: { fromAgentId, botId },
                    ...senderAgentIdMetadata(fromAgentId),
                },
            },
        );
        if (accepted.id !== messageId) {
            throw new Error("Agent Base did not preserve the requested message ID.");
        }
        return structuredClone(bot);
    }

    /**
     * Renames the bot and the conversation with it. A bot is one continuous chat, so its session
     * is called whatever the bot is called. The immutable username, folder, and workspace do not
     * move, and the agent's own version advances separately from the bot's.
     */
    async rename(
        ctx: Context,
        botId: string,
        name: string,
        expectedVersion: number,
    ): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.name === name) return current;
            await this.#setAgentTitle(txCtx, current.agentId, name);
            return await this.#change(txCtx, current, (bot) => ({ ...bot, name }));
        });
    }

    async reorder(
        ctx: Context,
        botId: string,
        afterId: string | null,
        expectedVersion: number,
    ): Promise<BotRecord> {
        if (afterId === botId) throw new BotConflictError("A bot cannot be placed after itself.");
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            const ordered = (await readBots(txCtx)).filter((bot) => bot.id !== botId);
            const afterIndex =
                afterId === null ? -1 : ordered.findIndex((candidate) => candidate.id === afterId);
            if (afterId !== null && afterIndex < 0) {
                throw new BotConflictError("The bot to place after was not found.");
            }
            const orderKey = orderKeyBetween(
                afterIndex < 0 ? null : (ordered[afterIndex]?.orderKey ?? null),
                ordered[afterIndex + 1]?.orderKey ?? null,
            );
            return await this.#change(txCtx, current, (bot) =>
                bot.orderKey === orderKey ? undefined : { ...bot, orderKey },
            );
        });
    }

    async archive(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.status === "archived") return current;
            await this.#abort.abort(txCtx, current.agentId);
            await this.#setAgentArchived(txCtx, current.agentId, true);
            return await this.#change(txCtx, current, (bot) => ({
                ...bot,
                status: "archived",
                archivedAt: Date.now(),
            }));
        });
    }

    async unarchive(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.status === "active") return current;
            await this.#setAgentArchived(txCtx, current.agentId, false);
            return await this.#change(txCtx, current, (bot) => {
                const active: BotRecord = { ...bot, status: "active" };
                delete active.archivedAt;
                return active;
            });
        });
    }

    async setAvatar(
        ctx: Context,
        botId: string,
        bytes: Uint8Array,
        contentType: "image/jpeg" | "image/png" | "image/webp",
        expectedVersion: number,
    ): Promise<BotRecord> {
        // Re-encoding happens before the transaction opens. Every transaction on this database
        // runs to completion before the next one begins, so holding one open across image work
        // would stall every other writer for as long as the picture takes.
        const asset = await normalizeBotAvatar(bytes, contentType);
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            return await this.#writeAvatar(txCtx, current, asset, "user");
        });
    }

    /**
     * Lets a bot choose its own picture. The caller is identified by its agent, and the write
     * ignores versioning because the bot is not racing another device's view of itself.
     */
    async setOwnAvatar(ctx: Context, agentId: string, bytes: Uint8Array): Promise<BotRecord> {
        const asset = await normalizeBotAvatar(bytes);
        return await ctx.inTx(async (txCtx) => {
            const current = await readBotByAgent(txCtx, agentId);
            if (current === undefined) {
                throw new BotNotFoundError("Only a bot can set its own avatar.");
            }
            if (current.status === "archived") {
                throw new BotConflictError("An archived bot cannot change its avatar.");
            }
            return await this.#writeAvatar(txCtx, current, asset, "generated");
        });
    }

    async #writeAvatar(
        ctx: Context,
        current: BotRecord,
        asset: BotAvatarAsset,
        source: "user" | "generated",
    ): Promise<BotRecord> {
        await writeBotAvatar(ctx, current.id, asset);
        return await this.#change(ctx, current, (bot) => ({
            ...bot,
            avatar: { kind: "image", source, thumbhash: asset.thumbhash },
        }));
    }

    async clearAvatar(ctx: Context, botId: string, expectedVersion: number): Promise<BotRecord> {
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, botId);
            this.#assertVersion(current, expectedVersion);
            if (current.avatar === undefined) return current;
            await deleteBotAvatar(txCtx, botId);
            return await this.#change(txCtx, current, (bot) => {
                const without: BotRecord = { ...bot };
                delete without.avatar;
                return without;
            });
        });
    }

    async avatar(ctx: Context, botId: string): Promise<BotAvatarAsset | undefined> {
        const bot = await this.#required(ctx, botId);
        if (bot.avatar === undefined) return undefined;
        return structuredClone(await readBotAvatar(ctx, botId));
    }

    /**
     * Apply one decided change to a bot that was read in this same transaction.
     *
     * The stored version is asserted again by the update itself, so a row that moved between the
     * read and the write is refused rather than overwritten.
     */
    async #change(
        ctx: Context,
        current: BotRecord,
        decide: (bot: BotRecord) => BotRecord | undefined,
    ): Promise<BotRecord> {
        const decided = decide(structuredClone(current));
        if (decided === undefined) return current;
        const next: BotRecord = {
            ...decided,
            version: current.version + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        };
        const workspaceChanged =
            next.status !== current.status || next.archivedAt !== current.archivedAt;
        if (workspaceChanged) {
            next.workspaceVersion = current.workspaceVersion + 1;
            next.workspaceUpdatedAt = next.updatedAt;
        }
        if (!Value.Check(botRecordSchema, next)) throw new Error("The bot mutation is invalid.");
        const stored = await updateBot(ctx, next, current.version);
        this.#publish(ctx, {
            eventId: globalThis.crypto.randomUUID(),
            at: stored.updatedAt,
            type: "bot_updated",
            bot: stored,
            previousBot: current,
        });
        return stored;
    }

    async #setAgentArchived(ctx: Context, agentId: string, archived: boolean): Promise<void> {
        await this.#updateAgentMetadata(ctx, agentId, {
            archivedAt: archived ? Date.now() : null,
        });
    }

    /** Keep the conversation's title equal to the bot's display name. */
    async #setAgentTitle(ctx: Context, agentId: string, title: string): Promise<void> {
        await this.#updateAgentMetadata(ctx, agentId, { title });
    }

    /** Write bot-owned agent metadata, advancing the agent's own version and timestamp. */
    async #updateAgentMetadata(
        ctx: Context,
        agentId: string,
        update: Readonly<Record<string, unknown>>,
    ): Promise<void> {
        const agents = this.#requireAgents();
        const config = await agents.config(ctx, agentId);
        if (config === undefined) throw new Error("The bot agent was not found.");
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        await agents.updateMetadata(ctx, agentId, { ...update, updatedAt: Date.now(), version });
    }

    async #chooseUsername(ctx: Context, name: string, supplied?: string): Promise<string> {
        if (supplied !== undefined) {
            if ((await readBotByUsername(ctx, supplied)) !== undefined) {
                throw new BotConflictError("That bot username is already in use.");
            }
            return supplied;
        }
        const base = derivedUsername(name);
        for (let suffix = 1; suffix < 1_000_000; suffix += 1) {
            const tail = suffix === 1 ? "" : `_${String(suffix)}`;
            const username = `${base.slice(0, 64 - tail.length)}${tail}`;
            if ((await readBotByUsername(ctx, username)) === undefined) return username;
        }
        throw new BotConflictError("A unique bot username could not be chosen.");
    }

    async #unusedIdentity(ctx: Context, excluded: ReadonlySet<string>): Promise<string> {
        const agents = this.#requireAgents();
        for (;;) {
            const id = createId();
            if (excluded.has(id)) continue;
            if ((await readBot(ctx, id)) !== undefined) continue;
            if ((await readBotByWorkspace(ctx, id)) !== undefined) continue;
            if ((await readBotByAgent(ctx, id)) !== undefined) continue;
            if ((await agents.config(ctx, id)) !== undefined) continue;
            return id;
        }
    }

    async #required(ctx: Context, botId: string): Promise<BotRecord> {
        const bot = await readBot(ctx, botId);
        if (bot === undefined) throw new BotNotFoundError();
        return bot;
    }

    #assertVersion(bot: BotRecord, expectedVersion: number): void {
        if (bot.version !== expectedVersion) throw new BotConflictError("The bot has changed.");
    }

    #publish(ctx: Context, event: BotEvent): void {
        if (!Value.Check(botEventSchema, event)) throw new Error("The bot event is invalid.");
        const frozen = deepFreeze(structuredClone(event)) as BotEvent;
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of [...this.#listeners]) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A bot subscriber failed.",
                        { eventId: frozen.eventId },
                        error,
                    );
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The bots module has not started.");
        return this.#agents;
    }
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function derivedUsername(name: string): string {
    let username = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (username.length === 0) username = "bot";
    if (!/^[a-z]/.test(username)) username = `bot_${username}`;
    return username.slice(0, 64).replace(/_+$/g, "") || "bot";
}

/** Decimal-fraction sort key, compared lexicographically. */
function orderKeyBetween(before: string | null, after: string | null): string {
    const lower = before ?? "";
    if (after !== null && lower >= after) throw new Error("Bot order keys are out of order.");
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const low = index < lower.length ? lower.charCodeAt(index) - 48 : 0;
        const high = after !== null && index < after.length ? after.charCodeAt(index) - 48 : 10;
        if (high - low > 1) return `${prefix}${String(low + Math.floor((high - low) / 2))}`;
        if (high - low === 1)
            return `${prefix}${String(low)}${orderKeyAbove(lower.slice(index + 1))}`;
        prefix += String(low);
    }
}

function orderKeyAbove(rest: string): string {
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const digit = index < rest.length ? rest.charCodeAt(index) - 48 : 0;
        if (digit < 9) return `${prefix}${String(digit + Math.floor((10 - digit) / 2))}`;
        prefix += "9";
    }
}
